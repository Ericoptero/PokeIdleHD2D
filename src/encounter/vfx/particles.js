/**
 * particles.js — one shared particle field for every strike, one draw call.
 *
 * Copies `environment/weather.js`'s pattern (named in the plan as the one to copy): a single
 * hand-built `BufferGeometry` of `COUNT` quads sharing one `ShaderMaterial`, every particle's
 * placement computed **in the vertex shader** from a per-vertex `aSeed` attribute plus a
 * handful of uniforms — no `InstancedMesh`, no per-frame CPU matrix writes.
 *
 * The one deliberate departure from `weather.js`: that file drives its shader from `uTime`
 * (wall-clock seconds, gated `if (!config.timeFrozen)` by its caller). This file is driven
 * entirely by `uPhase`, the strike's own `[0,1]` — the same quantity `strikes.js` (this
 * system's predecessor) already used for a frozen screenshot to be reproducible. There is no
 * clock here to gate at all.
 *
 * **Continuous emission, not a discrete burst call.** Each particle has a birth point spread
 * evenly across `[uTravelStart, uTravelEnd]` (`aSeed.x`), and originates at `mix(uFrom, uTo,
 * aSeed.x)` — so for a projectile (`uFrom` the attacker, `uTo` the target, a wide window) that
 * reads as a trailing stream, each particle further along the line the later it was born; for
 * a contact or field strike (`uFrom === uTo`, the target, a narrow window timed to the impact
 * beat) every particle originates at the same point and it reads as a compact burst — the same
 * shader, no branching on shape, only what `play.js` hands it. Each particle's own life is a
 * fixed span after its birth (`envelope`, below) — a rise, fall, zigzag, orbit or spiral
 * outward, `elements.js`'s `MOTION`, scaled by the type's own `intensity`.
 */

const COUNT = 128;
/** How long a particle lives after birth, as a fraction of the whole strike's phase. */
const LIFE = 0.42;

const PARTICLE_VERT = /* glsl */`
attribute vec3 aSeed; // x: birth fraction [0,1) within [uTravelStart, uTravelEnd]; y,z: jitter
varying vec2 vUv;
varying float vAge;
uniform vec3 uFrom, uTo;
uniform float uPhase, uTravelStart, uTravelEnd, uStrength, uMotion, uFlash;

void main() {
  vUv = uv;
  float span = max(uTravelEnd - uTravelStart, 0.001);
  float birth = uTravelStart + aSeed.x * span;
  float life = ${LIFE.toFixed(3)} * (0.7 + 0.6 * aSeed.y);
  float age = clamp((uPhase - birth) / max(life, 1e-4), 0.0, 1.0);
  vAge = age;

  vec3 origin = mix(uFrom, uTo, aSeed.x);

  float ang = aSeed.x * 62.83 + aSeed.y * 6.283;
  vec3 offset = vec3(0.0);
  // MOTION codes (elements.js MOTION_CODE): 0 rise, 1 fall, 2 zigzag, 3 orbit, 4 spiral.
  if (uMotion < 0.5) {
    // rise: drifts up and gently out.
    offset = vec3(cos(ang) * age * 0.35, age * 1.35, sin(ang) * age * 0.35);
  } else if (uMotion < 1.5) {
    // fall: materialises above and drops onto the origin.
    offset = vec3(cos(ang) * (1.0 - age) * 0.12, (1.0 - age) * 1.1, sin(ang) * (1.0 - age) * 0.12);
  } else if (uMotion < 2.5) {
    // zigzag: lateral jitter that grows with age, radiating outward.
    float w = sin(age * 18.0 + ang * 3.0);
    offset = vec3(w * age * 0.55, age * 0.5, cos(age * 14.0 + ang) * age * 0.5);
  } else if (uMotion < 3.5) {
    // orbit: a steady ring around the origin.
    float a2 = ang + age * 5.0;
    float r = 0.35 + age * 0.25;
    offset = vec3(cos(a2) * r, 0.25 + sin(age * 6.0) * 0.12, sin(a2) * r);
  } else {
    // spiral: an orbit whose radius and height both grow with age.
    float a2 = ang + age * 7.5;
    float r = age * 0.7;
    offset = vec3(cos(a2) * r, age * 1.0, sin(a2) * r);
  }

  vec3 world = origin + offset * uStrength;
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  // Envelope: fades in and out over its own life, zero before birth and after death alike —
  // sin(age*pi) is exactly 0 at age 0 and age 1, so no extra step() is needed either end.
  float env = sin(clamp(age, 0.0, 1.0) * 3.14159265);
  float size = mix(0.16, 0.42, 0.4 + 0.6 * aSeed.z) * (0.55 + 0.45 * env) * uStrength;
  mv.xy += vec2(position.x, position.y) * size;
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vAge;
uniform vec3 uColorA, uColorB;
uniform float uRole, uFlash;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float shape;
  // ROLE codes (elements.js ROLE_CODE): 0 spark, 1 ember, 2 shard, 3 droplet, 4 leaf, 5 dust.
  if (uRole < 0.5) {
    // spark: a tight, hard-edged diamond.
    shape = smoothstep(0.55, 0.15, abs(p.x) + abs(p.y));
  } else if (uRole < 1.5) {
    // ember: a soft round glow.
    shape = smoothstep(1.0, 0.0, d) * 0.9;
  } else if (uRole < 2.5) {
    // shard: an angular triangle-ish wedge.
    shape = smoothstep(0.5, 0.1, max(abs(p.x) * 0.8 + p.y * 0.5, d - 0.15));
  } else if (uRole < 3.5) {
    // droplet: elongated vertically, rounder at the base.
    shape = smoothstep(1.0, 0.0, length(vec2(p.x * 1.6, (p.y - 0.15) * 0.85)));
  } else if (uRole < 4.5) {
    // leaf: elongated horizontally.
    shape = smoothstep(1.0, 0.0, length(vec2(p.x * 0.8, p.y * 1.8)));
  } else {
    // dust: very soft and small.
    shape = smoothstep(0.7, 0.0, d) * 0.6;
  }
  float a = shape * sin(clamp(vAge, 0.0, 1.0) * 3.14159265);
  if (a <= 0.01) discard;
  vec3 col = mix(uColorA, uColorB, vAge);
  col = mix(col, vec3(1.0), uFlash * (1.0 - vAge));
  gl_FragColor = vec4(col, a);
}
`;

/** Builds `n` unit quads sharing one buffer, each stamped with a deterministic seed triple —
 *  a pure function of its index, so the same field lays out identically every run without
 *  touching `ctx.rng` (this is cosmetic jitter, not anything a save or a seam depends on). */
function seededQuadField(THREE, n) {
  const pos = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const seed = new Float32Array(n * 12);
  const idx = new Uint32Array(n * 6);
  const QX = [-1, 1, 1, -1], QY = [-1, -1, 1, 1];
  const hash = (x) => {
    const s = Math.sin(x * 127.1) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let i = 0; i < n; i++) {
    // Birth fractions spread evenly across [0,1) rather than left to a hash's own clumping,
    // so a short travel window still births particles across its whole length.
    const s = [i / n, hash(i * 1.618), hash(i * 2.719 + 0.5)];
    for (let v = 0; v < 4; v++) {
      const o = i * 4 + v;
      pos[o * 3] = QX[v]; pos[o * 3 + 1] = QY[v]; pos[o * 3 + 2] = 0;
      uv[o * 2] = (QX[v] + 1) * 0.5; uv[o * 2 + 1] = (QY[v] + 1) * 0.5;
      seed[o * 3] = s[0]; seed[o * 3 + 1] = s[1]; seed[o * 3 + 2] = s[2];
    }
    const b = i * 4;
    idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geo;
}

/** The field's own allocated size — `src/encounter/selftest.js` pins that nothing ever asks
 *  for more than this many particles' worth of look. */
export const PARTICLE_COUNT = COUNT;

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 */
export function makeParticleField(THREE, scene) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
    uniforms: {
      uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3() },
      uPhase: { value: 0 }, uTravelStart: { value: 0 }, uTravelEnd: { value: 0.5 },
      uStrength: { value: 1 }, uMotion: { value: 0 }, uRole: { value: 0 }, uFlash: { value: 0 },
      uColorA: { value: new THREE.Color(0xffffff) }, uColorB: { value: new THREE.Color(0x888888) },
    },
    transparent: true, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(seededQuadField(THREE, COUNT), mat);
  mesh.name = 'encounter:vfx:particles';
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  scene.add(mesh);

  return {
    mesh,
    /** @param {{from:object,to:object,phase:number,travelStart?:number,travelEnd:number,motion:number,role:number,strength:number,flash:number,colorA:string,colorB:string}} p */
    update(p) {
      // Unlike `beams.js`/`ground.js`, always `true` rather than gated on an opacity: a
      // particle field has no single opacity for the whole mesh, only per-particle envelopes
      // the fragment shader already zeroes and discards — `play.js`'s own `hide()` is what
      // turns this mesh off between strikes.
      mesh.visible = true;
      const u = mat.uniforms;
      u.uFrom.value.set(p.from.x, p.from.y, p.from.z);
      u.uTo.value.set(p.to.x, p.to.y, p.to.z);
      u.uPhase.value = p.phase;
      u.uTravelStart.value = p.travelStart ?? 0;
      u.uTravelEnd.value = Math.max(p.travelEnd, (p.travelStart ?? 0) + 0.001);
      u.uMotion.value = p.motion;
      u.uRole.value = p.role;
      u.uStrength.value = p.strength;
      u.uFlash.value = p.flash ?? 0;
      u.uColorA.value.set(p.colorA);
      u.uColorB.value.set(p.colorB);
    },
    hide() { mesh.visible = false; },
    dispose() { scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); },
  };
}
