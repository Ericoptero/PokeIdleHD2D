/**
 * Weather: clear / rain / fog / snow (src/environment/index.js).
 *
 * Atmosphere is done in presets.js (`applyWeather` bends the whole grade); this file is the
 * part you can see moving. Two meshes, two draw calls, both allocated once at init:
 *
 *   precip  2400 quads — rain streaks or snow flakes, chosen by a uniform
 *   mist      32 quads — big soft sheets that drift across the mid ground
 *
 * Both live in a box that follows the camera focus and wrap inside it, so the player never
 * walks out of the weather and the vertex count never depends on how far they have walked.
 *
 * **Determinism.** Every particle's lane, phase and speed comes from `ctx.rng.fork()` at
 * init, so the same seed lays the same field down every time. Motion advances with the
 * frame clock and stops dead when `config.timeFrozen` is set, which is how a weather
 * screenshot is made reproducible: `?timeFrozen=1` gives the same pixels on every run.
 */

const PRECIP_VERT = /* glsl */`
attribute vec3 aSeed;     // x: lane phase, y: speed jitter, z: size jitter
varying vec2 vUv;
varying float vFade;
uniform vec3  uOrigin;    // camera focus, snapped
uniform vec2  uExtent;    // half-width, height of the wrap box
uniform float uTime, uAmount, uSnow, uFall, uDrift;

float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  vUv = uv;
  // Lay the field out on a golden-ratio lattice: deterministic, and it never bands.
  float id  = aSeed.x;
  float gx  = fract(id * 0.7548776662) * 2.0 - 1.0;
  float gz  = fract(id * 0.5698402909) * 2.0 - 1.0;

  float speed = uFall * (0.75 + 0.5 * aSeed.y);
  float y = fract(id * 0.3819660113 + uTime * speed / uExtent.y);
  // Snow sways; rain does not.
  float sway = uSnow * (sin(uTime * (0.7 + aSeed.y) + id * 19.0) * 0.9
                      + sin(uTime * (1.9 + aSeed.z) + id * 7.0) * 0.35);

  vec3 world = uOrigin;
  world.x += gx * uExtent.x + sway + uDrift * y * uExtent.y * 0.25;
  world.z += gz * uExtent.x + sway * 0.6;
  world.y += y * uExtent.y;

  // Cull the tail of the buffer when the intensity is low, instead of resizing it.
  float live = step(fract(id * 0.9171) , uAmount);
  vFade = live * (0.55 + 0.45 * aSeed.z);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  float w = mix(0.030, 0.115, uSnow) * (0.7 + 0.6 * aSeed.z);
  float hgt = mix(0.62, 0.115, uSnow) * (0.7 + 0.6 * aSeed.y);
  mv.xy += vec2(position.x * w, position.y * hgt) * live;
  gl_Position = projectionMatrix * mv;
}
`;

const PRECIP_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vFade;
uniform vec3 uColor;
uniform float uSnow, uOpacity;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  // A drop is a soft vertical line; a flake is a round dot.
  float rain = (1.0 - abs(p.x)) * (1.0 - abs(p.y) * 0.35);
  float snow = smoothstep(1.0, 0.15, length(p));
  float a = mix(rain, snow, uSnow) * vFade * uOpacity;
  if (a <= 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const MIST_VERT = /* glsl */`
attribute vec3 aSeed;
varying vec2 vUv;
varying float vFade;
uniform vec3 uOrigin;
uniform vec2 uExtent;
uniform float uTime, uAmount;
void main() {
  vUv = uv;
  float id = aSeed.x;
  float drift = uTime * (0.035 + aSeed.y * 0.05);
  float gx = fract(id * 0.7548776662 + drift) * 2.0 - 1.0;
  float gz = fract(id * 0.5698402909 + drift * 0.35) * 2.0 - 1.0;
  vec3 world = uOrigin + vec3(gx * uExtent.x, uExtent.y * (0.10 + 0.55 * aSeed.z), gz * uExtent.x);
  vFade = step(fract(id * 0.9171), uAmount) * (0.35 + 0.65 * aSeed.z);
  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  mv.xy += position.xy * (7.0 + 9.0 * aSeed.y) * vFade;
  gl_Position = projectionMatrix * mv;
}
`;

const MIST_FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying float vFade;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float a = pow(max(0.0, 1.0 - length(p)), 2.2) * vFade * uOpacity;
  if (a <= 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}
`;

const PRECIP_COUNT = 2400;
const MIST_COUNT = 32;

/** Builds `n` unit quads sharing one buffer, each with its own deterministic seed triple. */
function quadField(THREE, n, rng) {
  const pos = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const seed = new Float32Array(n * 12);
  const idx = new Uint32Array(n * 6);
  const QX = [-1, 1, 1, -1], QY = [-1, -1, 1, 1];
  for (let i = 0; i < n; i++) {
    const s = [i + rng.next() * 0.999, rng.next(), rng.next()];
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

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 * @param {{next():number}} rng  a forked stream — never the root
 */
export function makeWeather(THREE, scene, rng) {
  const group = new THREE.Group();
  group.name = 'env:weather';
  scene.add(group);

  const precipMat = new THREE.ShaderMaterial({
    vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG,
    uniforms: {
      uOrigin: { value: new THREE.Vector3() },
      uExtent: { value: new THREE.Vector2(26, 20) },
      uTime: { value: 0 }, uAmount: { value: 0 }, uSnow: { value: 0 },
      uFall: { value: 26 }, uDrift: { value: 0.35 }, uOpacity: { value: 0.5 },
      uColor: { value: new THREE.Color(0xcfe0f2) },
    },
    transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
    blending: THREE.NormalBlending,
  });
  const precip = new THREE.Mesh(quadField(THREE, PRECIP_COUNT, rng), precipMat);
  precip.name = 'env:precip';
  precip.frustumCulled = false;
  precip.renderOrder = 15;
  precip.visible = false;
  group.add(precip);

  const mistMat = new THREE.ShaderMaterial({
    vertexShader: MIST_VERT, fragmentShader: MIST_FRAG,
    uniforms: {
      uOrigin: { value: new THREE.Vector3() },
      uExtent: { value: new THREE.Vector2(34, 12) },
      uTime: { value: 0 }, uAmount: { value: 0 }, uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0x9fb0be) },
    },
    transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
  });
  const mist = new THREE.Mesh(quadField(THREE, MIST_COUNT, rng), mistMat);
  mist.name = 'env:mist';
  mist.frustumCulled = false;
  mist.renderOrder = 14;
  mist.visible = false;
  group.add(mist);

  return {
    /**
     * @param {{kind:string, amount:number}} particles  from `applyWeather`
     * @param {THREE.Color} tint     roughly the fog colour, so precipitation belongs to the hour
     * @param {number} time          seconds
     * @param {THREE.Vector3} focus  camera focus
     */
    update(particles, tint, time, focus) {
      const kind = particles?.kind ?? 'none';
      const amount = Math.max(0, Math.min(1, particles?.amount ?? 0));

      const wantPrecip = (kind === 'rain' || kind === 'snow') && amount > 0.01;
      precip.visible = wantPrecip;
      if (wantPrecip) {
        const snow = kind === 'snow' ? 1 : 0;
        const u = precipMat.uniforms;
        u.uTime.value = time;
        u.uSnow.value = snow;
        u.uAmount.value = snow ? Math.min(1, 0.45 + amount * 0.55) : amount;
        u.uFall.value = snow ? 2.4 : 30;
        u.uDrift.value = snow ? 0.9 : 0.28;
        u.uOpacity.value = snow ? 0.95 : 0.42 + 0.3 * amount;
        // Snow gets a tighter box than rain: the same flake count over a smaller volume is
        // what makes it read as weather rather than as dust.
        u.uExtent.value.set(snow ? 15 : 22, snow ? 11 : 22);
        // Precipitation is lit by the sky, so it takes the hour's colour and stays a touch
        // brighter than the air behind it.
        u.uColor.value.copy(tint).lerp(
          snow ? { r: 1, g: 1, b: 1 } : { r: 0.78, g: 0.86, b: 1.0 }, snow ? 0.75 : 0.55);
        u.uOrigin.value.set(Math.round(focus.x), focus.y - (snow ? 3 : 5), Math.round(focus.z));
      }

      const wantMist = kind === 'mist' && amount > 0.01;
      mist.visible = wantMist;
      if (wantMist) {
        const u = mistMat.uniforms;
        u.uTime.value = time;
        u.uAmount.value = Math.min(1, 0.35 + amount * 0.65);
        u.uOpacity.value = 0.10 + 0.16 * amount;
        u.uColor.value.copy(tint).lerp({ r: 1, g: 1, b: 1 }, 0.25);
        u.uOrigin.value.set(Math.round(focus.x), focus.y - 1.0, Math.round(focus.z));
      }
    },

    dispose() {
      precip.geometry.dispose(); precipMat.dispose();
      mist.geometry.dispose(); mistMat.dispose();
      scene.remove(group);
    },
  };
}
