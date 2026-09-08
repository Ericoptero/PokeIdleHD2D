/**
 * Practical lights — street lamps, windows, camp fires (ARCHITECTURE §5.3).
 *
 * Three halves, because "a street lamp at night" is three different problems:
 *
 *   1. a `PointLight`, so the *geometry* around the bulb gets modelled — the post, the kerb,
 *      a bench end, the front of a sprite walking past — instead of flat-tinted;
 *   2. a **ground pool decal**, a flat quad lying on the pavement under the bulb, because a
 *      point light alone cannot be relied on to put a *readable* pool on the floor: it lands
 *      on whatever the material's normal and shadow term let it land on, and once four of
 *      them overlap on a plaza the eye reads the sum as ambient. The decal is the pool the
 *      composition needs, and its falloff is authored rather than inverse-square;
 *   3. an additive glow quad at the bulb, whose colour sits *above* the bloom threshold on
 *      purpose. That is what makes bloom something only lamps trigger at night, rather than
 *      a haze over the whole frame.
 *
 * The point-light pool is allocated once and never resized, and every light in it stays
 * `visible` for the whole session with `intensity 0` when it is unused. `NUM_POINT_LIGHTS`
 * is a shader `#define` derived from the number of *visible* lights, so hiding a light at
 * dawn recompiles every material in the scene mid-frame; a light at zero costs a multiply.
 */

const MAX_LIGHTS = 16;

/**
 * Candela per unit of a lamp spec's `intensity`, and the hard ceiling on its reach.
 *
 * Round 2 shrank the reach from 12 to 7 and called it a pool. It is not one: the plaza's
 * lamps stand about six cells apart, so at reach 7 every point on the paving is inside two
 * or three windows at once and the sum is flat — measured on `r2`'s own `city-21`, paving
 * under a lamp read 103 and paving six cells away 102. A pool needs its window to close
 * *before* the next lamp's opens.
 *
 * A short window is what makes it a pool: with the bulb at y 3.3 the paving under it is
 * already 3.3 away, so `(1 − (d/cutoff)⁴)²` has most of its fall behind it and the next lamp
 * six cells off contributes nothing. `POOL_GAIN` buys back the peak the small window costs.
 */
const POOL_GAIN = 22;
const POOL_REACH = 3.9;
const POOL_DECAY = 1.5;

/**
 * `POOL_DECAY` is 1.5, not the physical 2, and that is the number this round is actually
 * about. A lamp has two jobs at two very different distances — model the *post* it hangs on
 * (1–2 units) and lay a pool on the *paving* below it (3.3 units) — and inverse-square gives
 * the near one 19× the far one. Round 2 tuned for the pool and the post took nothing; tuning
 * for the post instead blew the post, the flowerbed and the hedge in front of it to white
 * (`docs/progress/environment/r3/a4-21.png`). At decay 1.5 the same pool on the ground costs
 * 13× at the post instead of 19×, so both can be right at once:
 *
 *   distance                       decay 2 / gain 37     decay 1.5 / gain 20
 *   1.5   the post, mid-shaft            15.7                  10.6
 *   3.3   the pavement under the bulb     0.81                  0.81
 *
 * It is a defensible physical lie as well as a useful one: a real street lantern is a
 * diffusing globe a third of a unit across, and a sphere of that size falls off slower than
 * a point until you are several radii away from it.
 */

/**
 * How far the painted pool reaches, in world units, per unit of the spec's `radius`, and
 * the ceiling on it. The decal is what the player actually reads as "there is a lamp there",
 * so it is deliberately *wider* than the point light's window and much softer: light on a
 * floor spreads further than it models.
 */
const DECAL_REACH = 4.2;
/**
 * How far above `terrain.height()` the painted pool is laid.
 *
 * Not a z-fighting epsilon — a *thickness*. `heightAt` is the cell's placement base, and a
 * tile's own geometry stands on top of it, so a quad 0.03 above the base sits *inside* the
 * paving slab and every one of its fragments fails the depth test. That is exactly what the
 * first version did: 234 draw calls against 233, one more shader program, and a frame
 * byte-identical to the same frame with the decal switched off. 0.30 clears every ground
 * tile in `bw2-adastra` (the thickest lands its top face at 0.25) and at a 45 degree camera
 * displaces the pool about a fifth of a cell up-screen, which is invisible.
 */
const DECAL_LIFT = 0.30;

/**
 * Where the point light actually sits, relative to the bulb the scene registered.
 *
 * A lamp head is a *diffuser*, not a filament: the light leaves a glass globe roughly a
 * third of a unit across, and the faces of the post it hangs from are lit by the half of
 * that globe pointing back at them. A mathematical point at the emitter cannot do that, and
 * the failure is visible rather than academic — the AdAstra cobra head reaches a full cell
 * sideways off its post (DECISIONS #25), so the post's camera-facing faces have `dot(N, L)`
 * slightly *negative* from a bulb directly above and to one side, and take literally none of
 * their own lamp. That is the whole of "the pole is taking moon/fill only": at night it was a
 * cold blue-grey stick standing under an amber glare.
 *
 * Dropping the source a third of a unit and bringing it a half unit toward the camera (yaw is
 * fixed, §2.7, so +z *is* toward the camera) puts it inside the globe rather than at its top
 * edge, and every camera-facing surface within a couple of units — the post, a bench end, the
 * front of a sprite walking past — turns positive. The pool on the ground moves by less than
 * a fifth of a cell, which is under one screen pixel at this camera.
 */
const BULB_DROP = 0.26;
const BULB_TOWARD_CAMERA = 0.46;

const GLOW_VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aColor;
attribute float aSize;
attribute float aSeed;
varying vec2 vUv;
varying vec3 vColor;
uniform float uTime;
uniform float uOn;
void main() {
  vUv = uv * 2.0 - 1.0;
  // A lamp is never perfectly steady; a slow two-rate flicker reads as gas or old sodium.
  float f = 0.93 + 0.07 * sin(uTime * (2.1 + aSeed * 3.0) + aSeed * 31.0)
                 * (0.5 + 0.5 * sin(uTime * 0.61 + aSeed * 11.0));
  vColor = aColor * uOn * f;
  // Billboard: build the quad in view space so it always faces the camera.
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  mv.xy += position.xy * aSize * (0.85 + 0.15 * f);
  // Then push it 0.42 units *toward* the camera. The emitter sits inside the lantern's own
  // geometry, so a quad centred exactly on it loses its whole lower half to the depth test
  // against the lamp head — which is why the round-2 fixture read as a dark navy dart with a
  // yellow sticker behind it. The offset is smaller than the head is deep, so the glow still
  // disappears correctly behind a wall or a roof in front of the lamp.
  mv.z += 0.42;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  // Core plus halo. The core is what crosses the bloom threshold; the halo is the glare
  // you would see through air, and it has to stay smooth while the world stays chunky.
  // The halo carries a wider exponent than the core because a sodium lamp seen at night is
  // a small white filament inside a large orange glare, and it is the *glare* that says
  // "lit" at twenty metres — the round-2 pair (2.6) made a tight bead the eye read as a
  // sticker stuck on a dark fixture.
  float core = pow(max(0.0, 1.0 - r * 2.6), 3.0);
  float halo = pow(max(0.0, 1.0 - r), 1.7);
  gl_FragColor = vec4(vColor * (core * 3.2 + halo * 0.95), 1.0);
}
`;

const POOL_VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec3 aColor;
attribute float aSize;
varying vec2 vUv;
varying vec3 vColor;
uniform float uOn;
void main() {
  vUv = position.xy;
  vColor = aColor * uOn;
  // The quad is built flat in world XZ around the lamp's *base*, not billboarded: this is
  // light lying on a floor, and it has to keep its shape as the camera moves.
  vec3 world = aCenter + vec3(position.x * aSize, 0.0, position.y * aSize);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}
`;

const POOL_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float k = 1.0 - r;
  // A knee, not a cone: a bright plateau roughly a cell and a half across, then a long soft
  // shoulder. Two exponents rather than one because a single pow() either has no centre or
  // no edge, and the edge is the half the eye reads as falloff.
  float f = pow(k, 3.0) * 1.30 + pow(k, 1.3) * 0.42;
  gl_FragColor = vec4(vColor * f, 1.0);
}
`;

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 * @param {(x:number,z:number)=>number} [groundAt]  world height under a bulb, for the pool
 *   decal. Resolved once per `add()` — `terrain` is up by the time any scene registers a
 *   lamp, and if it is not, a flat 0 is the right answer for every map we ship.
 */
export function makeLamps(THREE, scene, groundAt) {
  /** @type {{x:number,y:number,z:number,groundY:number,color:THREE.Color,intensity:number,
   *          radius:number,size:number,pool:boolean,point:boolean,seed:number}[]} */
  const lamps = [];

  const group = new THREE.Group();
  group.name = 'env:lamps';
  scene.add(group);

  const pool = [];
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffb867, 0, POOL_REACH, POOL_DECAY);
    l.name = `env:lamp${i}`;
    // Never hidden: see the header. A light that vanishes changes NUM_POINT_LIGHTS and
    // recompiles every material in the scene.
    l.visible = true;
    group.add(l);
    pool.push(l);
  }

  // --- glow quads and ground pools: one geometry each, rebuilt only when lamps change ----
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: { uTime: { value: 0 }, uOn: { value: 0 } },
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: true, fog: false, toneMapped: false,
  });
  const glow = new THREE.Mesh(geo, mat);
  glow.name = 'env:lampGlow';
  glow.frustumCulled = false;
  glow.renderOrder = 20;
  glow.visible = false;
  group.add(glow);

  const poolGeo = new THREE.BufferGeometry();
  const poolMat = new THREE.ShaderMaterial({
    vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
    uniforms: { uOn: { value: 0 } },
    transparent: true,
    // `dst * (1 + src)`, not `dst + src`. A painted pool that *adds* HDR light puts the same
    // number of photons on black grass as on pale paving, which is how a decal stops reading
    // as light and starts reading as fog; multiplying by what is already there keeps the
    // surface's own albedo and its own shadow, which is what a real pool does. It also means
    // the pool can never lift a pixel the sun never reached, so a lamp cannot flatten the
    // night the way round 2's point-light flood did.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.OneFactor,
    depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    // DoubleSide, and it is load-bearing rather than defensive. The quad is built flat in
    // world XZ, and with the index order used here its winding reads *clockwise* from a
    // camera above it — so under three's default FrontSide every fragment was back-face
    // culled. The symptom is a decal that costs a draw call and a shader program and puts
    // nothing on screen: 234 draws against 233, 20 programs against 19, and a frame
    // byte-identical to the same frame with `?envNoDecal=1`. Found by bisecting the vertex
    // shader — a clip-space passthrough of the same geometry drew a disc, the same geometry
    // through `projectionMatrix * modelViewMatrix` drew nothing, at any world position.
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const pools = new THREE.Mesh(poolGeo, poolMat);
  pools.name = 'env:lampPools';
  pools.frustumCulled = false;
  pools.renderOrder = 15;
  pools.visible = false;
  group.add(pools);

  let dirty = false;
  /** How many lamps got a ground pool at the last rebuild. See the gate in `update`. */
  let poolCount = 0;

  function rebuild() {
    dirty = false;
    const n = lamps.length;
    glow.visible = n > 0;
    poolCount = 0;
    if (!n) { pools.visible = false; return; }
    const pos = new Float32Array(n * 12);
    const uv = new Float32Array(n * 8);
    const cen = new Float32Array(n * 12);
    const col = new Float32Array(n * 12);
    const siz = new Float32Array(n * 4);
    const sed = new Float32Array(n * 4);
    const idx = new Uint32Array(n * 6);
    const QX = [-1, 1, 1, -1], QY = [-1, -1, 1, 1];
    // The pool decals are a second, shorter list: only lamps that stand over ground get one.
    const withPool = lamps.filter((L) => L.pool);
    const m = withPool.length;
    poolCount = m;
    const pPos = new Float32Array(m * 12);
    const pCen = new Float32Array(m * 12);
    const pCol = new Float32Array(m * 12);
    const pSiz = new Float32Array(m * 4);
    const pIdx = new Uint32Array(m * 6);

    for (let i = 0; i < n; i++) {
      const L = lamps[i];
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v);
        pos[o * 3] = QX[v]; pos[o * 3 + 1] = QY[v]; pos[o * 3 + 2] = 0;
        uv[o * 2] = (QX[v] + 1) * 0.5; uv[o * 2 + 1] = (QY[v] + 1) * 0.5;
        cen[o * 3] = L.x; cen[o * 3 + 1] = L.y; cen[o * 3 + 2] = L.z;
        col[o * 3] = L.color.r * L.intensity;
        col[o * 3 + 1] = L.color.g * L.intensity;
        col[o * 3 + 2] = L.color.b * L.intensity;
        siz[o] = L.size; sed[o] = L.seed;
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    for (let i = 0; i < m; i++) {
      const L = withPool[i];
      // How hard the pool paints. `intensity` is authored for the point light, which is an
      // inverse-square term; the decal is a multiply, so it is compressed to a sane range
      // rather than used raw — a 2.0 street lamp doubles what it stands on, a 0.5 shop
      // window warms it by a third.
      // Round 2's 0.46 put the core of a pool at 0.99x the same paving at noon — a plaza
      // that reads as daylight with the sky switched off. 0.28 lands it near 0.6x, which is
      // still the brightest ground in the frame and still unmistakably night.
      const k = Math.min(1.0, 0.205 * L.intensity + 0.035);
      const reach = Math.min(DECAL_REACH, L.radius * 0.42);
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v);
        pPos[o * 3] = QX[v]; pPos[o * 3 + 1] = QY[v]; pPos[o * 3 + 2] = 0;
        pCen[o * 3] = L.x; pCen[o * 3 + 1] = L.groundY + DECAL_LIFT; pCen[o * 3 + 2] = L.z;
        pCol[o * 3] = L.color.r * k;
        pCol[o * 3 + 1] = L.color.g * k;
        pCol[o * 3 + 2] = L.color.b * k;
        pSiz[o] = reach;
      }
      const b = i * 4;
      pIdx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(sed, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();

    pools.visible = m > 0;
    poolGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    poolGeo.setAttribute('aCenter', new THREE.BufferAttribute(pCen, 3));
    poolGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
    poolGeo.setAttribute('aSize', new THREE.BufferAttribute(pSiz, 1));
    poolGeo.setIndex(new THREE.BufferAttribute(pIdx, 1));
    poolGeo.computeBoundingSphere();
  }

  let seedCounter = 0;

  return {
    /**
     * @param {{x:number,y:number,z:number,color?:number,intensity?:number,radius?:number,
     *          size?:number, point?:boolean, pool?:boolean, groundY?:number}} spec
     *   world position of the *bulb*, not the post base.
     *   `point: false` registers a bulb that gets the glow quad and the bloom but never
     *   claims one of the `PointLight` slots — asked for by `city` in STATUS.coreRequests.
     *   `pool: false` suppresses the painted ground pool, which is the right answer for a
     *   bulb that does not hang over walkable ground (a first-floor window, a sign).
     *   `groundY` overrides the terrain lookup for the pool's height.
     */
    add(spec) {
      const x = spec.x, z = spec.z;
      let groundY = spec.groundY;
      if (!Number.isFinite(groundY)) {
        const h = groundAt?.(x, z);
        groundY = Number.isFinite(h) ? h : 0;
      }
      const lamp = {
        x, z, y: spec.y,
        groundY,
        color: new THREE.Color(spec.color ?? 0xffb060),
        intensity: spec.intensity ?? 1,
        radius: spec.radius ?? 11,
        size: spec.size ?? 0.85,
        point: spec.point !== false,
        // A bulb more than four units up is a window or a sign, not a street light: it is
        // lighting a wall, and painting a pool on the pavement under it would be a lie.
        pool: spec.pool !== undefined ? spec.pool !== false : (spec.y - groundY) <= 4.2,
        // Deterministic flicker phase: derived from the index, never from Math.random.
        seed: ((seedCounter++ * 0.6180339887) % 1),
      };
      lamps.push(lamp);
      dirty = true;
      return lamp;
    },
    clear() {
      lamps.length = 0; dirty = true;
      glow.visible = false; pools.visible = false;
    },
    count: () => lamps.length,
    list: () => lamps.slice(),

    /**
     * The `n` bulbs that matter most around `focus`, as plain
     * `{ x, y, z, power }` — what `castShadows` needs to throw a character's shadow away
     * from the lantern nearest its own feet instead of away from a sun that is not in the
     * room. Ranked by `intensity / (1 + d²)` rather than by distance, so a bright brazier
     * eight cells off still beats a dim crystal six cells off, which is what the eye does.
     *
     * @param {{x:number,z:number}} focus
     * @param {number} [n]
     */
    nearest(focus, n = 4) {
      if (!lamps.length) return [];
      const fx = focus?.x ?? 0, fz = focus?.z ?? 0;
      return lamps
        .map((L) => {
          const dx = L.x - fx, dz = L.z - fz;
          return { L, w: L.intensity / (1 + dx * dx + dz * dz) };
        })
        .sort((a, b) => b.w - a.w)
        .slice(0, n)
        .map(({ L }) => ({ x: L.x, y: L.y, z: L.z, power: L.intensity }));
    },

    /**
     * @param {number} on     0..1 ramp from the time-of-day preset
     * @param {number} time   seconds, for the flicker
     * @param {THREE.Vector3} focus  camera focus; the point-light pool follows the nearest
     * @param {{noPool?:boolean, noDecal?:boolean}} [dev]  verification toggles (index.js)
     */
    update(on, time, focus, dev) {
      if (dirty) rebuild();
      mat.uniforms.uTime.value = time;
      mat.uniforms.uOn.value = on;
      poolMat.uniforms.uOn.value = dev?.noDecal ? 0 : on;
      // `poolCount`, not `poolGeo.index != null`: a rebuild with no ground bulbs leaves a
      // zero-count index behind, and three still issues the draw — a draw call and a shader
      // program for nothing, which is exactly the failure this decal shipped with once.
      pools.visible = !dev?.noDecal && on > 0.002 && poolCount > 0;

      if (!lamps.length || on <= 0.002 || dev?.noPool) {
        for (const l of pool) l.intensity = 0;
        return;
      }
      // Only MAX_LIGHTS lamps get a real point light. Pick the ones nearest the camera so
      // the pool always spends itself on what fills the frame; `point: false` bulbs are not
      // candidates at all.
      const order = lamps.map((l, i) => {
        const dx = l.x - focus.x, dz = l.z - focus.z;
        return { i, d: dx * dx + dz * dz };
      }).filter((o) => lamps[o.i].point).sort((a, b) => a.d - b.d);

      for (let k = 0; k < pool.length; k++) {
        const l = pool[k];
        const src = order[k] ? lamps[order[k].i] : null;
        if (!src) { l.intensity = 0; continue; }
        l.position.set(src.x, src.y - BULB_DROP, src.z + BULB_TOWARD_CAMERA);
        l.color.copy(src.color);
        l.distance = Math.min(src.radius, POOL_REACH);
        l.intensity = src.intensity * on * POOL_GAIN;
      }
    },

    dispose() {
      geo.dispose(); mat.dispose();
      poolGeo.dispose(); poolMat.dispose();
      scene.remove(group);
    },
  };
}
