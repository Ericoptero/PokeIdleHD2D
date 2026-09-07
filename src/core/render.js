/**
 * The HD2D render pipeline (ARCHITECTURE §2.7). Owned by core, tuned by `environment`.
 *
 * The whole look rests on one decision: the 3D scene is rendered into a *small* HDR buffer
 * (640x360 at 1080p) and then blown up with NEAREST. Geometry pixels stay chunky and sit on
 * the same pixel grid as the sprites, which is what makes 3D meshes and DS pixel art read
 * as one image instead of two. Bloom is composited *after* the upscale so light stays
 * smooth — that is exactly the split visible in docs/refs/03 and 04.
 *
 *   scene ─▶ sceneRT (low, HDR) ─┬─▶ bright ─▶ blur x3 ─┐
 *                                └──── NEAREST upscale ─┴─▶ AgX ─▶ grade ─▶ vignette ─▶ canvas
 */

import * as THREE from 'three';

// RawShaderMaterial + glslVersion GLSL3 means three prepends `#version 300 es` itself and
// declares nothing else, so these are written as plain ES 3.00 with explicit in/out.
const FS_VERT = /* glsl */`
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BRIGHT_FRAG = /* glsl */`
precision highp float;
out vec4 fragColor;
uniform sampler2D tScene;
uniform float uThreshold;
uniform float uSoftKnee;
in vec2 vUv;
void main() {
  vec3 c = texture(tScene, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Soft knee so a light does not pop into bloom the instant it crosses the threshold.
  float knee = uThreshold * uSoftKnee + 1e-5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float w = max(soft, l - uThreshold) / max(l, 1e-5);
  fragColor = vec4(c * w, 1.0);
}
`;

const BLUR_FRAG = /* glsl */`
precision highp float;
out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uDir;          // texel-sized step, one axis at a time
in vec2 vUv;
void main() {
  // 9-tap gaussian, linear-sampled: sigma ~ 2.4 texels
  vec3 sum = texture(tSrc, vUv).rgb * 0.227027;
  sum += (texture(tSrc, vUv + uDir * 1.3846).rgb + texture(tSrc, vUv - uDir * 1.3846).rgb) * 0.316216;
  sum += (texture(tSrc, vUv + uDir * 3.2308).rgb + texture(tSrc, vUv - uDir * 3.2308).rgb) * 0.070270;
  fragColor = vec4(sum, 1.0);
}
`;

const COMPOSITE_FRAG = /* glsl */`
precision highp float;
out vec4 fragColor;
uniform sampler2D tScene;       // NEAREST — the pixel grid
uniform sampler2D tBloom0;      // LINEAR  — smooth light
uniform sampler2D tBloom1;
uniform sampler2D tBloom2;
uniform float uExposure, uBloom, uVignette, uGrain, uSaturation, uContrast, uTime;
uniform vec3  uLift, uGain;
in vec2 vUv;

// AgX, the Blender/three fit. Handles saturated lamps at night without hue-shifting them
// to white, which ACES does and which reads as "video game bloom".
const mat3 AgXIn = mat3(
  0.8566271, 0.0951212, 0.0482516,
  0.1373190, 0.7612019, 0.1014594,
  0.1118982, 0.0767493, 0.8813402);
const mat3 AgXOut = mat3(
   1.1271005, -0.1413297, -0.1413297,
  -0.1106067,  1.1578237, -0.1106067,
  -0.0164939, -0.0164939,  1.2519364);

vec3 agxDefaultContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return  15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x
        + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 c) {
  const float minEv = -12.47393, maxEv = 4.026069;
  c = AgXIn * max(c, 0.0);
  c = clamp(log2(max(c, 1e-10)), minEv, maxEv);
  c = (c - minEv) / (maxEv - minEv);
  c = agxDefaultContrast(c);
  c = AgXOut * c;
  return clamp(c, 0.0, 1.0);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 scene = texture(tScene, vUv).rgb;
  vec3 bloom = texture(tBloom0, vUv).rgb * 0.5
             + texture(tBloom1, vUv).rgb * 0.32
             + texture(tBloom2, vUv).rgb * 0.18;
  vec3 c = scene + bloom * uBloom;

  c *= uExposure;
  c = agx(c);

  // lift/gain grade, then saturation and a gentle S-curve
  c = clamp(c * uGain + uLift, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);

  float d = distance(vUv, vec2(0.5));
  c *= 1.0 - uVignette * smoothstep(0.32, 0.86, d);

  c += (hash(vUv * 1024.0 + uTime) - 0.5) * uGrain;

  fragColor = vec4(c, 1.0);
}
`;

function fullscreenQuad(material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

export function makeRenderer({ container, config, log }) {
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    stencil: false, depth: true,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;     // we tone-map in the composite pass
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(config.fov, 16 / 9, 0.5, 300);

  // --- render targets -------------------------------------------------------
  const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.NoColorSpace };
  const sceneRT = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: true, samples: 0 });
  sceneRT.texture.minFilter = THREE.NearestFilter;
  sceneRT.texture.magFilter = THREE.NearestFilter;
  sceneRT.texture.generateMipmaps = false;

  const makeBlurRT = () => {
    const rt = new THREE.WebGLRenderTarget(2, 2, { ...rtOpts, depthBuffer: false });
    rt.texture.minFilter = THREE.LinearFilter;
    rt.texture.magFilter = THREE.LinearFilter;
    rt.texture.generateMipmaps = false;
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  };
  const bright = makeBlurRT();
  const mips = [0, 1, 2].map(() => ({ a: makeBlurRT(), b: makeBlurRT() }));

  const postScene = new THREE.Scene();
  const postCam = new THREE.Camera();

  const brightMat = new THREE.RawShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: BRIGHT_FRAG,
    uniforms: { tScene: { value: sceneRT.texture }, uThreshold: { value: 0.7 }, uSoftKnee: { value: 0.5 } },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  const blurMat = new THREE.RawShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: BLUR_FRAG,
    uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  const compositeMat = new THREE.RawShaderMaterial({
    vertexShader: FS_VERT,
    fragmentShader: COMPOSITE_FRAG,
    uniforms: {
      tScene: { value: sceneRT.texture },
      tBloom0: { value: mips[0].a.texture },
      tBloom1: { value: mips[1].a.texture },
      tBloom2: { value: mips[2].a.texture },
      uExposure: { value: config.exposure }, uBloom: { value: config.bloomStrength },
      uVignette: { value: config.vignette }, uGrain: { value: config.grain },
      uSaturation: { value: config.saturation }, uContrast: { value: config.contrast },
      uTime: { value: 0 },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
    },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });

  const quad = fullscreenQuad(brightMat);
  postScene.add(quad);

  // --- sizing ---------------------------------------------------------------
  let outW = 0, outH = 0, inW = 0, inH = 0;

  function resize(width, height) {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    const scale = Math.max(1, Math.round(config.pixelScale));
    const iw = Math.max(2, Math.min(config.maxInternalWidth, Math.floor(w / scale)));
    const ih = Math.max(2, Math.floor(iw * (h / w)));
    // Reallocating render targets is expensive and config changes every frame while the
    // clock runs, so bail out unless something that matters actually moved.
    if (w === outW && h === outH && iw === inW && ih === inH) return;
    outW = w; outH = h; inW = iw; inH = ih;

    renderer.setSize(outW, outH, false);
    sceneRT.setSize(inW, inH);
    bright.setSize(inW >> 1, inH >> 1);
    mips.forEach((m, i) => {
      const w = Math.max(2, (inW >> 1) >> i), h = Math.max(2, (inH >> 1) >> i);
      m.a.setSize(w, h); m.b.setSize(w, h);
    });
    camera.aspect = outW / outH;
    camera.updateProjectionMatrix();
  }

  function blit(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(postScene, postCam);
  }

  function syncUniforms() {
    const u = compositeMat.uniforms;
    u.uExposure.value = config.exposure;
    u.uBloom.value = config.bloomStrength;
    u.uVignette.value = config.vignette;
    u.uGrain.value = config.grain;
    u.uSaturation.value = config.saturation;
    u.uContrast.value = config.contrast;
    brightMat.uniforms.uThreshold.value = config.bloomThreshold;
  }

  let frameCount = 0;

  function render() {
    if (!outW) return;
    renderer.info.reset();
    syncUniforms();
    compositeMat.uniforms.uTime.value = (frameCount++ % 64) * 0.017;

    renderer.setRenderTarget(sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // bloom: threshold once, then blur three progressively smaller mips
    blit(brightMat, bright);
    let src = bright.texture;
    for (let i = 0; i < mips.length; i++) {
      const { a, b } = mips[i];
      blurMat.uniforms.tSrc.value = src;
      blurMat.uniforms.uDir.value.set(1 / a.width, 0);
      blit(blurMat, b);
      blurMat.uniforms.tSrc.value = b.texture;
      blurMat.uniforms.uDir.value.set(0, 1 / a.height);
      blit(blurMat, a);
      src = a.texture;
    }

    blit(compositeMat, null);
    renderer.setRenderTarget(null);
  }

  /** Values the harness reports; `renderer.info` is reset each frame above. */
  function stats() {
    const i = renderer.info;
    return {
      drawCalls: i.render.calls,
      triangles: i.render.triangles,
      programs: i.programs?.length ?? 0,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
      internal: [inW, inH],
      output: [outW, outH],
    };
  }

  function dispose() {
    sceneRT.dispose(); bright.dispose();
    mips.forEach((m) => { m.a.dispose(); m.b.dispose(); });
    brightMat.dispose(); blurMat.dispose(); compositeMat.dispose();
    renderer.dispose();
    canvas.remove();
  }

  const ctx = renderer.getContext();
  const lost = () => log.error('WebGL context lost — the page must be reloaded');
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost(); });
  if (!ctx) log.error('WebGL2 unavailable');

  return {
    renderer, scene, camera, canvas,
    resize, render, stats, dispose,
    /** environment tunes the grade through here */
    grade: compositeMat.uniforms,
    get internalSize() { return [inW, inH]; },
  };
}

/**
 * Fixed 45-degree camera rig (ARCHITECTURE §2.7). Yaw is locked; the camera never rotates,
 * it only follows, with a critically damped spring so grid steps do not read as stutter.
 */
export function makeCameraRig({ camera, config }) {
  const focus = new THREE.Vector3();
  const target = new THREE.Vector3();
  const offset = new THREE.Vector3();
  let snapped = false;

  function recomputeOffset() {
    const pitch = THREE.MathUtils.degToRad(config.cameraPitch);
    const d = config.cameraDistance;
    // Looking north-ish and down: the camera sits south of and above the focus.
    offset.set(0, Math.sin(pitch) * d, Math.cos(pitch) * d);
  }

  return {
    get focus() { return focus; },
    setFocus(x, y, z, immediate = false) {
      target.set(x, y, z);
      if (immediate || !snapped) { focus.copy(target); snapped = true; }
    },
    update(dt) {
      recomputeOffset();
      // Exponential smoothing that is frame-rate independent.
      const k = 1 - Math.pow(config.cameraDamping, Math.max(dt, 1e-4) * 60);
      focus.lerp(target, Math.min(1, k));
      camera.position.copy(focus).add(offset);
      camera.lookAt(focus.x, focus.y + config.cameraLookAhead, focus.z);
      camera.fov = config.fov;
      camera.updateProjectionMatrix();
    },
    /** Frames a rectangle of the world — used by showcases and the screenshot presets. */
    frame(cx, cz, y = 0, distance = null) {
      if (distance != null) config.set({ cameraDistance: distance });
      this.setFocus(cx, y, cz, true);
      this.update(1);
    },
  };
}

/**
 * A directional sun whose shadow camera is snapped to shadow-map texels. Unsnapped shadow
 * maps shimmer as the camera moves, and shimmering reads as amateur instantly.
 */
export function makeSunShadow({ config }) {
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.castShadow = true;
  const cam = light.shadow.camera;
  light.shadow.mapSize.set(config.shadowMapSize, config.shadowMapSize);
  light.shadow.bias = config.shadowBias;
  light.shadow.normalBias = config.shadowNormalBias;
  light.target.position.set(0, 0, 0);

  const dir = new THREE.Vector3(0.5, 1, 0.3).normalize();

  function update(focus) {
    const extent = config.shadowExtent;
    cam.left = -extent / 2; cam.right = extent / 2;
    cam.top = extent / 2; cam.bottom = -extent / 2;
    cam.near = 0.5; cam.far = extent * 3;

    // Snap the focus to whole shadow texels along the light's own basis.
    const texel = extent / config.shadowMapSize;
    const sx = Math.round(focus.x / texel) * texel;
    const sz = Math.round(focus.z / texel) * texel;
    const sy = Math.round(focus.y / texel) * texel;

    light.target.position.set(sx, sy, sz);
    light.position.set(sx + dir.x * extent, sy + dir.y * extent, sz + dir.z * extent);
    light.target.updateMatrixWorld();
    cam.updateProjectionMatrix();
    light.shadow.needsUpdate = true;
  }

  return {
    light,
    /** environment drives this from the solar position */
    setDirection(x, y, z) { dir.set(x, y, z).normalize(); },
    get direction() { return dir; },
    update,
  };
}
