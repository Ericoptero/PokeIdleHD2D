/**
 * The overworld sprite field: every creature, trainer and NPC billboard in the scene, in
 * one InstancedMesh, plus one more for their contact shadows. Two draw calls for the whole
 * cast (tools/shots/shoot.js), whatever the cast is.
 *
 * The billboard is an upright quad with its origin at the bottom-centre, so it stands on
 * the ground and is depth-tested against the world like anything else: a tree one cell
 * nearer the camera occludes it, a cliff behind it does not. The camera's yaw is fixed
 * (core/render.js never rotates it), so the quad faces the camera with no per-frame
 * rotation at all — it only ever needs its height stretched by 1/cos(pitch) so that the
 * 45-degree view does not squash the art (see sprites.js).
 *
 * Frames come from a shared atlas. Each instance carries the uv rect of the frame it is
 * showing in an `aUvRect` attribute, patched into the material the same way the tile world
 * patches its global-mapping offset, so animating a hundred sprites costs
 * one buffer upload and no extra draw calls.
 */

import { SpriteAtlas } from './atlas.js';
import { FOOT_PAD_TEXELS, TEXELS_PER_UNIT, frameWorldSize, headLiftOf, pokemonCycle, trainerCycle } from './sprites.js';

/** Soft round shadow, generated once. A ring of stops keeps the falloff from banding. */
function makeBlobTexture(THREE) {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0.00, 'rgba(0,0,0,1)');
  grad.addColorStop(0.42, 'rgba(0,0,0,0.92)');
  grad.addColorStop(0.68, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.86, 'rgba(0,0,0,0.18)');
  grad.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.name = 'pokemon:contact-shadow';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

const UV_CHUNK = 'vMapUv = aUvRect.xy + uv * aUvRect.zw;';

/*
 * There is no half-pixel phase here any more, and there must not be one again.
 *
 * A sprite's edge lands on a pixel boundary when `dim / 2 + v` is a whole number, so `v` wants
 * to be whole on an even buffer and a half on an odd one — and `resize()` used to round the
 * internal buffer up to whatever it landed on, so odd was the ordinary case away from 1080p
 * (1512x982 gave 504x328, 1600x900 gave 534x301). That needed a `snapTo(v, phase)` here, and
 * it needed `render.js`'s own camera snap to apply the same phase, which it never did — so the
 * world sat on pixel centres while the sprites sat on edges. `resize()` now rounds both
 * internal dimensions up to **even**, which costs one pixel of overscan and
 * makes the phase zero everywhere. Plain `Math.round` is correct; a phase would now be a bug.
 */

/**
 * Shade the whole sprite by the shadow at its **feet**, not per fragment.
 *
 * A sprite is a flat cutout of DS pixel art with a tiny palette — the trainer's north frame
 * is fourteen colours — and `receiveShadow` samples the sun's shadow map once per fragment,
 * through `environment`'s PCSS filter. So a sprite standing on a shadow edge is softly graded
 * across its own face, and fourteen flat colours arrive on screen as a gradient of hundreds.
 * Measured on the running page: 2165 colours in one crop of the trainer, 1321 with
 * `?envNoShadow=1` — roughly 40% of the spread was this one lookup.
 *
 * The fix is to move the sample, not to remove it. `worldPosition` is swapped for the
 * instance's own origin for the duration of `shadowmap_vertex`, so every vertex writes the
 * *same* shadow coordinate, the varying interpolates to a constant, and the sprite darkens as
 * a whole the way a DS sprite does — while still darkening in a building's shade and going
 * blue at 21:00, which is the half of it that has to keep working.
 *
 * The nested `#include` is resolved after `onBeforeCompile`, so it expands normally.
 */
const SHADOW_GUARD =
  '#if ( defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 || NUM_POINT_LIGHT_SHADOWS > 0 ) ) '
  + '|| ( NUM_SPOT_LIGHT_COORDS > 0 )';

// The guard is three's own, verbatim: `worldpos_vertex` only *declares* `worldPosition` when
// something needs it, and a scene with no shadow-casting light — `?showcase=hunts&mode=cave`
// is one, lit entirely by ambient and practicals — declares nothing. Swapping it there is a
// vertex shader that does not compile, which the harness reports as a failed capture.
const FLAT_SHADOW_CHUNK = /* glsl */`
${SHADOW_GUARD}
  vec4 spriteWorldPosition_ = worldPosition;
  #ifdef USE_INSTANCING
    worldPosition = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  #endif
#endif
#include <shadowmap_vertex>
${SHADOW_GUARD}
  worldPosition = spriteWorldPosition_;
#endif
`;

export class SpriteField {
  /**
   * @param {typeof import('three')} THREE
   * @param {object} ctx  the core context
   */
  constructor(THREE, ctx, { capacity = 256, name = 'pokemon:sprites' } = {}) {
    this.THREE = THREE;
    this.ctx = ctx;
    this.capacity = capacity;
    this.atlas = new SpriteAtlas(THREE, { log: ctx.log });

    /** @type {Map<number, object>} */
    this.actors = new Map();
    this.nextId = 1;

    this.group = new THREE.Group();
    this.group.name = name;
    // Nothing to draw, and nothing to compile, until a sheet has been atlased.
    this.group.visible = false;

    // --- billboard ---------------------------------------------------------
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);                      // origin at the feet
    // A flat cutout has no real surface normal. Pointing it mostly up makes the sprite
    // take the same key light as the ground it stands on — which is what reads as "in the
    // scene" — with just enough lean toward the camera to keep some modelling.
    const n = geo.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0.78, 0.63);
    n.needsUpdate = true;
    this.geometry = geo;

    this.uvRects = new Float32Array(capacity * 4);
    this.uvAttr = new THREE.InstancedBufferAttribute(this.uvRects, 4);
    this.uvAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aUvRect', this.uvAttr);

    this.material = new THREE.MeshLambertMaterial({
      map: null,
      transparent: false,
      alphaTest: 0.5,               // cutout, so sprites stay in the opaque pass and depth-sort
      side: THREE.FrontSide,
      fog: true,
      name: 'pokemon:sprite',
    });
    // `vMapUv` only exists once the material has a map, so the patch has to wait for the
    // atlas. Without this guard an empty scene — the game booting with no sprites spawned
    // yet — compiles a shader that assigns to an undeclared identifier and logs a console
    // error, which is a budget failure on its own (tools/shots/shoot.js).
    this.material.onBeforeCompile = (shader) => {
      // The flat-shadow swap is independent of the atlas, so it is applied either way; the
      // uv-rect patch is not, because `vMapUv` only exists once the material has a map.
      // Without that guard an empty scene compiles a shader that assigns to an undeclared
      // identifier and logs a console error, which is a budget failure on its own (tools/shots/shoot.js).
      shader.vertexShader = shader.vertexShader
        .replace('#include <shadowmap_vertex>', FLAT_SHADOW_CHUNK);
      if (!this.material.map) return;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aUvRect;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n\t${UV_CHUNK}`);
    };
    this.material.customProgramCacheKey = () => (this.material.map ? 'pokemon-sprite-uvrect-flatshadow' : 'pokemon-sprite-bare-flatshadow');

    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;   // the cast shadow is the contact blob below
    this.mesh.receiveShadow = true; // but a sprite standing in a tree's shadow does darken
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.group.add(this.mesh);

    // --- contact shadows ---------------------------------------------------
    const blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
    this.blobGeometry = blobGeo;
    this.blobTexture = makeBlobTexture(THREE);
    this.blobMaterial = new THREE.MeshBasicMaterial({
      map: this.blobTexture,
      color: 0x000000,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      // Coplanar with the ground it lands on; the offset keeps it out of the depth fight
      // without a lift big enough to read as a gap at a 45-degree camera.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      toneMapped: false,
      fog: true,
      name: 'pokemon:contact-shadow',
    });
    this.blobs = new THREE.InstancedMesh(blobGeo, this.blobMaterial, capacity);
    this.blobs.name = `${name}:shadows`;
    this.blobs.frustumCulled = false;
    this.blobs.renderOrder = 2;
    this.blobs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blobs.count = 0;
    this.group.add(this.blobs);

    ctx.three.scene.add(this.group);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._rect = new Float32Array(4);
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._pitch = ctx.config.cameraPitch;
    // Scratch for the pixel snap; allocated once because `update()` runs every frame.
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    /** Sticky sprite magnification; see the pixel-grid block in `update()`. */
    this._mag = 0;
  }

  /** @returns {string} atlas key for a sheet url */
  static key(kind, url) { return `${kind}:${url}`; }

  /**
   * Loads sheets into the atlas.
   * @param {{kind:'pokemon'|'trainer', url:string}[]} sheets
   */
  async prepare(sheets) {
    const wanted = sheets.map((s) => ({ key: SpriteField.key(s.kind, s.url), url: s.url, kind: s.kind }));
    const rebuilt = await this.atlas.ensure(wanted);
    if (rebuilt || this.material.map !== this.atlas.texture) {
      this.material.map = this.atlas.texture;
      this.material.needsUpdate = true;
    }
    this.group.visible = !!this.atlas.texture;
    return this.atlas.stats();
  }

  /**
   * @param {object} spec
   * @param {'pokemon'|'trainer'} spec.kind
   * @param {string} spec.url            sheet url, already passed to prepare()
   * @param {number} [spec.x] @param {number} [spec.y] @param {number} [spec.z]  world position of the feet
   * @param {number} [spec.dir]          core/dir.js direction
   * @param {'idle'|'walk'|'run'} [spec.gait]
   * @param {number} [spec.phase]        animation phase; integer steps through the cycle
   * @param {number} [spec.scale]        extra scale on top of the sheet's own size
   * @returns {number} actor id
   */
  add(spec) {
    const key = SpriteField.key(spec.kind, spec.url);
    const layout = this.atlas.layout(key);
    if (!layout) { this.ctx.log.warn(`sprite field: sheet "${spec.url}" is not in the atlas`); return 0; }
    const id = this.nextId++;
    const size = frameWorldSize(layout.frame, this._pitch);
    this.actors.set(id, {
      id, key, kind: spec.kind, who: spec.who ?? spec.trainer ?? 'hero',
      x: spec.x ?? 0, y: spec.y ?? 0, z: spec.z ?? 0,
      dir: spec.dir ?? 0,
      gait: spec.gait ?? 'idle',
      phase: spec.phase ?? 0,
      scale: spec.scale ?? 1,
      frameTexels: layout.frame,
      // How much of the frame's own top margin `headLiftOf` (`sprites.js`) trims off before
      // measuring the head — the atlas's own `#measure`, carried on `layout` alongside
      // `frame`/`cols`/`rows`, never re-derived here.
      crown: layout.crown ?? 0,
      w: size.w * (spec.scale ?? 1),
      h: size.h * (spec.scale ?? 1),
      shadow: spec.shadow ?? 1,
      visible: spec.visible !== false,
    });
    return id;
  }

  /** @param {number} id @param {object} patch */
  set(id, patch) {
    const a = this.actors.get(id);
    if (!a) return;
    Object.assign(a, patch);
    if (patch.scale !== undefined) {
      const size = frameWorldSize(a.frameTexels, this._pitch);
      a.w = size.w * a.scale;
      a.h = size.h * a.scale;
    }
  }

  /**
   * `headLift` is derived, not stored: `headLiftOf(a.frameTexels, this._pitch, a.scale)` is
   * cheap and it is the one true source (`sprites.js`), so a fresh read here can never drift
   * from `a.h`/`a.scale` the way a field cached at `add()`/`set()` time would the moment
   * `update()`'s own pitch-change branch re-derives `h` without anyone remembering to also
   * patch a third copy of this math. It stays in raw world units — never multiplied by
   * `update()`'s pixel-grid magnification `k` — so it reads the same regardless of camera zoom.
   */
  get(id) {
    const a = this.actors.get(id);
    if (!a) return null;
    return { ...a, headLift: headLiftOf(a.frameTexels, this._pitch, a.scale, a.crown) };
  }
  remove(id) { this.actors.delete(id); }
  clear() { this.actors.clear(); this.mesh.count = 0; this.blobs.count = 0; }
  count() { return this.actors.size; }

  /** Sheet frame index an actor is showing right now. */
  /**
   * What the pixel grid came out as this frame. The harness asserts on it across device sizes
   * (`tools/shots/parity.js`); nothing in the game reads it.
   */
  grid() {
    const [inW, inH] = this.ctx.three.view?.internalSize ?? [0, 0];
    const upp = this.ctx.three.rig?.unitsPerPixel?.() ?? 0;
    return {
      internal: [inW, inH],
      unitsPerPixel: upp,
      pixelsPerUnit: upp > 0 ? 1 / upp : 0,
      mag: this._mag,
      texelsPerUnit: TEXELS_PER_UNIT,
      // 1 means the sheet is drawn at exactly its authored size. Anything else is the old
      // "the trainer is bigger on this screen" defect coming back.
      k: this._mag && upp > 0 ? this._mag / (1 / (TEXELS_PER_UNIT * upp)) : 0,
      actors: [...this.actors.values()].filter((a) => a.visible).map((a) => ({
        id: a.id, kind: a.kind, who: a.who ?? null, key: a.key,
        frame: this.frameOf(a), sx: a._sx ?? null, sy: a._sy ?? null,
        texels: this.atlas.layout(a.key)?.frame ?? 0,
      })),
    };
  }

  frameOf(a) {
    if (a.kind === 'trainer') {
      const cycle = trainerCycle(a.gait, a.dir, a.who);
      return cycle[Math.floor(a.phase) % cycle.length];
    }
    const cycle = pokemonCycle(a.dir);
    return a.gait === 'idle' ? cycle[0] : cycle[Math.floor(a.phase) % cycle.length];
  }

  /**
   * Writes every live actor into the two instanced meshes. Called once per rendered frame;
   * with a cast of tens this is a few hundred float writes, far cheaper than the state
   * changes any per-sprite object would cost.
   */
  update() {
    const pitch = this.ctx.config.cameraPitch;
    if (pitch !== this._pitch) {
      this._pitch = pitch;
      for (const a of this.actors.values()) {
        const size = frameWorldSize(a.frameTexels, pitch);
        a.w = size.w * a.scale; a.h = size.h * a.scale;
      }
    }

    // Ground direction the sun throws shadows in, and how far it stretches them.
    const sun = this.ctx.three.sun?.direction;
    let sunX = 0, sunZ = 0.35, stretch = 1.25;
    if (sun) {
      const len = Math.hypot(sun.x, sun.z) || 1;
      sunX = -sun.x / len; sunZ = -sun.z / len;
      stretch = 1 + Math.min(1.1, (1 - Math.min(1, Math.max(0, sun.y))) * 1.4);
    }
    const sunYaw = Math.atan2(sunX, sunZ);

    // --- the pixel grid ----------------------------------------------------
    // Sprites are drawn at a whole number of internal pixels per source texel, on the grid,
    // whatever the camera distance is. Everything the per-actor maths needs
    // is read once here rather than per sprite.
    //
    // The magnification is **one number for the whole cast**, taken at the camera's focus
    // plane — the plane the party stands on, and the same plane `makeCameraRig` snaps the
    // world to. Rounding per sprite instead, which is what round one did, meant rounding a
    // continuously moving depth: a walker crossing the x.5 boundary flipped between one and
    // two pixels per texel — a 2x strobe, measured at 33.0 px <-> 66.2 px on the lead
    // Pokemon — and two NPCs a few per cent apart in depth rendered at 33 px and 66 px in
    // the same frame. One shared integer cannot do either: the party is exact, everyone else
    // scales smoothly with depth the way perspective says they should.
    const { config, three } = this.ctx;
    const camera = three.camera;
    const inSize = three.view?.internalSize;
    const inW = inSize?.[0] ?? 0;
    const inH = inSize?.[1] ?? 0;
    const snap = !!config.spriteSnap && !!camera && inW > 0 && inH > 0;
    const pinned = Math.max(0, Math.round(config.spriteMagnification) || 0);
    let k = 1, upp = 0;
    let camRight = 0, camUp = 0;
    if (snap) {
      camera.updateMatrixWorld();
      this._right.setFromMatrixColumn(camera.matrixWorld, 0);
      this._up.setFromMatrixColumn(camera.matrixWorld, 1);
      this._camPos.setFromMatrixPosition(camera.matrixWorld);
      // The camera's own screen-plane coordinates, so the per-sprite snap can be taken
      // relative to it rather than to the world origin; see the block in the actor loop.
      camRight = this._camPos.dot(this._right);
      camUp = this._camPos.dot(this._up);
      // The rig owns the grid; re-deriving it here would be a second copy of the formula and
      // a second grid the first day someone edited one of them. It is a constant now — one
      // number for every depth on every device — so `mFloat` comes out whole rather than at
      // the 1.62 the perspective camera used to hand over, and `k` is exactly 1.
      upp = three.rig?.unitsPerPixel?.() ?? (1 / Math.max(1, config.pixelsPerUnit));
      if (upp > 0) {
        const mFloat = 1 / (TEXELS_PER_UNIT * upp);
        // Sticky, with a dead band. `pixelsPerUnit` is piecewise constant so a plain round
        // would already be stable, but a showcase that switches zoom would otherwise pump the
        // whole cast between two sizes on the way through the boundary.
        const want = Math.max(1, Math.round(mFloat));
        if (pinned > 0) this._mag = pinned;
        else if (!this._mag || Math.abs(mFloat - this._mag) > 0.6) this._mag = want;
        // How much bigger than nominal the sheet is drawn. `frameWorldSize` keeps its meaning
        // and stays the one owner of the 1/cos(pitch) aspect; this only zooms it. At the
        // shipped `pixelsPerUnit: 32` this is exactly 1 and the sheet is drawn at its
        // authored size, which is the point of the whole exercise.
        k = this._mag / mFloat;
      }
    }

    let i = 0;
    for (const a of this.actors.values()) {
      if (!a.visible || i >= this.capacity) continue;

      const frame = this.frameOf(a);
      this.atlas.rect(a.key, frame, this._rect);
      this.uvRects.set(this._rect, i * 4);

      // The quad stays upright and keeps `frameWorldSize`'s 1/cos(pitch) aspect — which is
      // what makes its texels square on a screen looking down at 45 degrees — and only grows
      // by `k`. The whole matrix therefore keeps the shape `environment/castShadows.js` reads
      // it back with (no rotation, scale (w, w/cos(pitch), 1), translation = the feet), and
      // the foot pad grows with it so the sole still lands on the ground.
      const dw = a.w * k, dh = a.h * k;
      const foot = (FOOT_PAD_TEXELS / TEXELS_PER_UNIT) * a.scale * k;
      this._p.set(a.x, a.y - foot, a.z);
      if (snap && upp > 0) {
        // Land the anchor on a whole internal pixel. The size is shared; where a sprite falls
        // on the grid is its own business, and without this the quad is the right size but
        // starts half a pixel into one and every texel boundary is a blend of two.
        //
        // Screen position is measured **from the camera**: `(p - camPos) . right / upp`. The
        // camera term used to be load-bearing for a second reason as well — under perspective
        // `upp` was only whole at the focus depth, so the follower, every city NPC and every
        // staged wild were snapped onto a grid that slid under them whenever the camera moved.
        // Orthographic removes the depth term entirely: one `upp`, every sprite, exact.
        const px = (this._p.dot(this._right) - camRight) / upp;
        const py = (this._p.dot(this._up) - camUp) / upp;
        this._p.addScaledVector(this._right, (Math.round(px) - px) * upp)
          .addScaledVector(this._up, (Math.round(py) - py) * upp);
        // Where the feet landed, in internal pixels from the top-left of the buffer. Only the
        // parity gate reads this (`tools/shots/parity.js`), and it needs the number the snap
        // actually produced rather than one recomputed from a rounded world position.
        a._sx = inW / 2 + Math.round(px);
        a._sy = inH / 2 - Math.round(py);
      }
      this._q.identity();
      this._s.set(dw, dh, 1);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);

      // The blob follows the frame's own content box, so it lands under the body and not
      // under the empty margin, and shifts with a leaning run frame. It sits a touch above
      // the ground to stay out of the depth fight with it, and stretches away from the sun
      // so the light direction reads even on dead flat ground.
      // Measured against the *drawn* width, not the nominal one: the sprite is magnified by
      // `k` and a blob left at nominal size would sit inside the feet.
      const box = this.atlas.box(a.key, frame) ?? { cx: 0.5, cw: 0.6 };
      const r = box.cw * dw * 0.5 * a.shadow;
      this._q.setFromAxisAngle(this._axisY, sunYaw);
      this._p.set(
        a.x + (box.cx - 0.5) * dw + sunX * r * (stretch - 1) * 0.5,
        a.y + 0.012,
        a.z + sunZ * r * (stretch - 1) * 0.5,
      );
      this._s.set(r * 2, 1, r * 2 * stretch);
      this._m.compose(this._p, this._q, this._s);
      this.blobs.setMatrixAt(i, this._m);

      i++;
    }

    this.mesh.count = i;
    this.blobs.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.blobs.instanceMatrix.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.blobGeometry.dispose();
    this.material.dispose();
    this.blobMaterial.dispose();
    this.blobTexture.dispose();
    this.atlas.dispose();
    this.actors.clear();
  }
}
