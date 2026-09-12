/**
 * beams.js — one ribbon, camera-facing by construction, used for both a projectile's trail
 * and a contact move's arc slash.
 *
 * The ribbon's *length* follows the true 3-D line between `uFrom` and `uTo` (whatever the
 * camera does), and its *width* is added in view space after the model-view transform — the
 * same trick `particles.js`/`environment/weather.js` use for their own billboarding. This is
 * why nothing here needs a `refit()`: `modelViewMatrix` already carries whichever camera the
 * renderer is drawing with this frame, so there is no separate "face the camera" step to
 * repeat every frame the way the old quaternion-copying system (`ball.js`, this system's
 * pixel-art predecessor) needed.
 *
 * **The width offset is perpendicular to the curve's own on-screen tangent, not to a fixed
 * screen axis.** A first cut added width along raw view-space Y, which for a bowed arc is
 * nearly parallel to the bow's own sweep at this camera's pitch — the two didn't cancel, they
 * *stacked*, so the "ribbon" filled in as one solid wedge the size of the whole swept arc
 * instead of a thin stroke tracing it (caught by screenshot: a magenta test fill rendered
 * exactly the footprint of a nearby terrain prop, sized like the whole bow, not a stroke).
 * Fixed by sampling the curve a hair further along, projecting *that* to view space too, and
 * turning the resulting 2-D tangent 90° — the width direction now actually follows the curve.
 * One shader serves both deliveries:
 *
 *   - a **projectile trail**: `uBow = 0` (a straight line), `uHeadK` sweeps `0→1` over the
 *     strike's own delivery beat so a bright head with a fading tail travels from attacker to
 *     target, `uTrailFrac` short.
 *   - a **contact arc**: `uHeadK = 1`, `uTrailFrac = 1` (the whole segment always revealed),
 *     `uBow > 0` bows the middle of the segment outward into a visible swing between the two
 *     creatures, `uOpacity` ramping in and back out over the beat instead of a travelling head.
 */

const BEAM_SEGMENTS = 20;

const BEAM_VERT = /* glsl */`
varying float vT;
uniform vec3 uFrom, uTo;
uniform float uHeadK, uTrailFrac, uBow, uWidth;

vec3 curvePoint(float t, vec3 perp) {
  float bow = uBow * sin(clamp(t, 0.0, 1.0) * 3.14159265);
  return mix(uFrom, uTo, clamp(t, 0.0, 1.0)) + perp * bow;
}

void main() {
  float tailT = max(0.0, uHeadK - uTrailFrac);
  float t = mix(tailT, uHeadK, uv.x);
  vT = uv.x;
  vec3 dir = normalize((uTo - uFrom) + vec3(1e-4, 0.0, 0.0));
  vec3 perp = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 1e-4, 0.0));
  vec3 world = curvePoint(t, perp);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  // The curve's own on-screen tangent: another point a hair further along, projected the same
  // way, so the width direction (its 2-D perpendicular) actually follows the bow instead of a
  // fixed screen axis — see the file header for the shape this replaced.
  vec3 aheadWorld = curvePoint(t + 0.01, perp);
  vec4 mvAhead = modelViewMatrix * vec4(aheadWorld, 1.0);
  vec2 tangent2D = mvAhead.xy - mv.xy;
  float tLen = length(tangent2D);
  vec2 normal2D = tLen > 1e-6 ? vec2(-tangent2D.y, tangent2D.x) / tLen : vec2(0.0, 1.0);

  float widthFall = uWidth * sin(clamp(uv.x, 0.0, 1.0) * 3.14159265);
  mv.xy += normal2D * (uv.y * 2.0 - 1.0) * widthFall;
  gl_Position = projectionMatrix * mv;
}
`;

const BEAM_FRAG = /* glsl */`
precision highp float;
varying float vT;
uniform vec3 uColorA, uColorB;
uniform float uOpacity, uFlash;

void main() {
  float edge = sin(clamp(vT, 0.0, 1.0) * 3.14159265);
  float a = edge * uOpacity;
  if (a <= 0.01) discard;
  vec3 col = mix(uColorB, uColorA, vT);
  col = mix(col, vec3(1.0), uFlash);
  gl_FragColor = vec4(col, a);
}
`;

/** A flat strip of `BEAM_SEGMENTS` quads along local x — `uv.x` is distance head-to-tail,
 *  `uv.y` is which edge of the ribbon (0/1), both read straight by the vertex shader above. */
function ribbonGeometry(THREE, segments) {
  const n = segments + 1;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const idx = new Uint32Array(segments * 6);
  for (let i = 0; i < n; i++) {
    const u = i / segments;
    for (let s = 0; s < 2; s++) {
      const o = (i * 2 + s) * 3;
      pos[o] = 0; pos[o + 1] = 0; pos[o + 2] = 0; // placed entirely by the vertex shader
      const ov = (i * 2 + s) * 2;
      uv[ov] = u; uv[ov + 1] = s;
    }
    if (i < segments) {
      const a = i * 2, b = a + 2;
      idx.set([a, a + 1, b, a + 1, b + 1, b], i * 6);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geo;
}

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 */
export function makeBeam(THREE, scene) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    uniforms: {
      uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3() },
      uHeadK: { value: 1 }, uTrailFrac: { value: 1 }, uBow: { value: 0 },
      uWidth: { value: 0.12 }, uOpacity: { value: 1 }, uFlash: { value: 0 },
      uColorA: { value: new THREE.Color(0xffffff) }, uColorB: { value: new THREE.Color(0x888888) },
    },
    transparent: true, depthWrite: false, depthTest: false, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(ribbonGeometry(THREE, BEAM_SEGMENTS), mat);
  mesh.name = 'encounter:vfx:beam';
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.visible = false;
  scene.add(mesh);

  return {
    mesh,
    /** @param {{from:object,to:object,headK:number,trailFrac:number,bow:number,width:number,opacity:number,flash:number,colorA:string,colorB:string}} p */
    update(p) {
      mesh.visible = p.opacity > 0.001;
      const u = mat.uniforms;
      u.uFrom.value.set(p.from.x, p.from.y, p.from.z);
      u.uTo.value.set(p.to.x, p.to.y, p.to.z);
      u.uHeadK.value = p.headK;
      u.uTrailFrac.value = p.trailFrac;
      u.uBow.value = p.bow;
      u.uWidth.value = p.width;
      u.uOpacity.value = p.opacity;
      u.uFlash.value = p.flash ?? 0;
      u.uColorA.value.set(p.colorA);
      u.uColorB.value.set(p.colorB);
    },
    hide() { mesh.visible = false; },
    dispose() { scene.remove(mesh); mesh.geometry.dispose(); mat.dispose(); },
  };
}
