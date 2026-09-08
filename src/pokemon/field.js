/**
 * The overworld sprite field: every creature, trainer and NPC billboard in the scene, in
 * one InstancedMesh, plus one more for their contact shadows. Two draw calls for the whole
 * cast (ARCHITECTURE §7), whatever the cast is.
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
 * patches its global-mapping offset (DECISIONS #8), so animating a hundred sprites costs
 * one buffer upload and no extra draw calls.
 */

import { SpriteAtlas } from './atlas.js';
import { FOOT_PAD_TEXELS, TEXELS_PER_UNIT, frameWorldSize, pokemonCycle, trainerCycle } from './sprites.js';

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
    // error, which is a budget failure on its own (ARCHITECTURE §7).
    this.material.onBeforeCompile = (shader) => {
      if (!this.material.map) return;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aUvRect;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>\n\t${UV_CHUNK}`);
    };
    this.material.customProgramCacheKey = () => (this.material.map ? 'pokemon-sprite-uvrect' : 'pokemon-sprite-bare');

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

  get(id) { return this.actors.get(id) ?? null; }
  remove(id) { this.actors.delete(id); }
  clear() { this.actors.clear(); this.mesh.count = 0; this.blobs.count = 0; }
  count() { return this.actors.size; }

  /** Sheet frame index an actor is showing right now. */
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
    const { THREE } = this;
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

    let i = 0;
    for (const a of this.actors.values()) {
      if (!a.visible || i >= this.capacity) continue;

      const frame = this.frameOf(a);
      this.atlas.rect(a.key, frame, this._rect);
      this.uvRects.set(this._rect, i * 4);

      const foot = (FOOT_PAD_TEXELS / TEXELS_PER_UNIT) * a.scale;
      this._p.set(a.x, a.y - foot, a.z);
      this._s.set(a.w, a.h, 1);
      this._m.compose(this._p, this._q.identity(), this._s);
      this.mesh.setMatrixAt(i, this._m);

      // The blob follows the frame's own content box, so it lands under the body and not
      // under the empty margin, and shifts with a leaning run frame. It sits a touch above
      // the ground to stay out of the depth fight with it, and stretches away from the sun
      // so the light direction reads even on dead flat ground.
      const box = this.atlas.box(a.key, frame) ?? { cx: 0.5, cw: 0.6 };
      const r = box.cw * a.w * 0.5 * a.shadow;
      this._q.setFromAxisAngle(this._axisY, sunYaw);
      this._p.set(
        a.x + (box.cx - 0.5) * a.w + sunX * r * (stretch - 1) * 0.5,
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
