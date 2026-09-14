// @ts-check
/**
 * The HD2D render pipeline (src/core/render.js). Owned by core, tuned by `environment`.
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
uniform float uExposure, uBloom, uVignette, uGrain, uSaturation, uContrast, uToe, uTime;
uniform vec3  uLift, uGain;
uniform vec2  uInternal;        // the low-res buffer's size, in pixels
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
  // Contrast with a soft toe instead of a hard clamp.
  //
  // (x - 0.5) * c + 0.5 sends everything below 0.5 - 0.5/c negative, and clamping that
  // to zero does not darken a colour — it DELETES a channel. At the golden hour's contrast
  // of 1.307 the crush point is 0.117, and 49.1% of a forest frame came out with its blue
  // channel at exactly 0 against docs/refs/04's 1.17%. That is why every critic has called
  // our shade "hue-killed" and "one orange": half the frame genuinely had no blue in it.
  //
  // 0.5 * (t + sqrt(t*t + w*w)) is a smooth maximum against zero. It tends to t well above
  // the toe, tends to 0 from above as t falls, and never clips — so a shadow keeps the
  // ratios between its channels and stays the colour of the sky that fills it.
  vec3 t = (c - 0.5) * uContrast + 0.5;
  c = min(0.5 * (t + sqrt(t * t + uToe * uToe)), vec3(1.0));

  // Vignette and grain are evaluated per INTERNAL pixel, not per output pixel.
  //
  // This pass runs at the canvas size, so one sprite texel — a 2x2 block of internal pixels
  // blown up to 6x6 output pixels — used to receive 36 different grain values and 36 points
  // along the vignette ramp. A flat 14-colour palette came out of it as hundreds of colours,
  // which is the "pixels that are not real" complaint at its source. Quantising the
  // coordinate keeps every output pixel inside one internal pixel identical, and leaves the
  // pass order and the bloom split (see the header) exactly as they were.
  vec2 q = floor(vUv * uInternal);
  vec2 qUv = (q + 0.5) / uInternal;

  float d = distance(qUv, vec2(0.5));
  c *= 1.0 - uVignette * smoothstep(0.32, 0.86, d);

  c += (hash(q + uTime) - 0.5) * uGrain;

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
  // Orthographic, and that is the whole of the pixel story.
  //
  // Under perspective one world unit covers a different number of pixels at every depth: at
  // the shipped pitch of 45 degrees and a 26-degree fov the ground plane alone ran from 0.75x
  // at the top of the screen to 1.20x at the bottom, so a single camera snap could only ever
  // put *one horizontal row* of the picture on the pixel grid. Everything else -- buildings,
  // fences, path tiles, every NPC not standing on the focus plane -- was resampled at a
  // fraction that moved as the camera followed the player, which is what "the pixel art gains
  // borders and loses definition while I walk" is.
  //
  // Orthographic makes `unitsPerPixel` depth-independent, so the snap below grids the entire
  // frame at once and a walk is an integer translation of it. The frustum is sized in
  // `resize()`, straight off the internal buffer and `config.pixelsPerUnit`.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.5, 300);

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
      uToe: { value: config.contrastToe },
      uTime: { value: 0 },
      uInternal: { value: new THREE.Vector2(1, 1) },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
    },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });

  const quad = fullscreenQuad(brightMat);
  postScene.add(quad);

  // --- sizing ---------------------------------------------------------------
  let outW = 0, outH = 0, inW = 0, inH = 0;

  /**
   * The canvas is an **integer multiple** of the internal buffer, and it **overscans** the
   * viewport by up to `scale` pixels rather than being stretched to fit it.
   *
   * `floor(w / scale)` does not divide back: a 1600-wide window gives 533, and blowing 533 up
   * to 1600 is x3.002 — so the NEAREST upscale hands out blocks 3 and 4 output pixels wide at
   * random, which is the same defect the sprite grid was fixed for, one stage later.
   *
   * Rounding **up** and letting the canvas hang off each edge, rather than down and leaving a
   * strip of page behind it: a letterbox is not free here, because every number this project
   * gates on comes from `sceneStats` over the whole PNG, and a black border reads as scene
   * content. Measured at the gate's own 1280x720: bars moved `belowL8Pct` on five of fifteen
   * frames and `boot/12`'s saturation 0.689 -> 0.540 without a pixel of the picture changing.
   * Overscan costs the outermost pixels of the frame instead, which nothing is composed
   * against.
   *
   * Two properties of the orthographic pixel grid:
   *
   * **Both internal dimensions are even.** A sprite's edge lands on a pixel boundary when
   * `dim / 2 + v` is whole, so on an odd buffer the world wants a whole `v` and the sprites
   * want a half — two grids, and `pokemon/field.js` carried a `phaseX/phaseY` workaround for
   * exactly that. Rounding up to even costs at most one more internal pixel of overscan and
   * makes the disagreement impossible instead of compensated.
   *
   * **`scale` adapts to the viewport** unless `config.pixelScale` pins it. There used to be a
   * `capped` branch that gave up and stretched once `maxInternalWidth` was hit; bumping the
   * scale keeps the upscale a whole number at every window size instead. It is also what makes
   * a phone work at all: at a pinned 3 a 390 px window rendered into a 130 px buffer, roughly
   * five pixels per tile.
   */
  function autoScale(w, h) {
    const target = Math.max(64, config.targetInternalWidth);
    let scale = Math.min(8, Math.max(1, Math.round(w / target)));
    // A whole scale that still fits the budget beats a fractional one that just fits.
    while (scale < 16 && (Math.ceil(w / scale) > config.maxInternalWidth
      || Math.ceil(h / scale) > config.maxInternalWidth)) scale++;
    return scale;
  }

  function resize(width, height) {
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    const scale = config.pixelScale > 0
      ? Math.max(1, Math.round(config.pixelScale))
      : autoScale(w, h);
    const even = (n) => Math.max(2, Math.ceil(n / 2) * 2);
    const iw = even(w / scale);
    // Straight off `h / scale`, not off the aspect. The old form derived the height from
    // `iw * (h / w)` so that a *capped* width could not stretch the picture; there is no cap
    // branch now, so the aspect is preserved by construction and this is both simpler and
    // symmetric in the overscan.
    const ih = even(h / scale);
    const ow = iw * scale;
    const oh = ih * scale;
    // Reallocating render targets is expensive and config changes every frame while the
    // clock runs, so bail out unless something that matters actually moved.
    if (ow === outW && oh === outH && iw === inW && ih === inH) return;
    outW = ow; outH = oh; inW = iw; inH = ih;
    compositeMat.uniforms.uInternal.value.set(inW, inH);

    // Centred at its exact size, so the overscan is split between the two edges. The inline
    // width/height beat `index.html`'s `100%`, and the UI canvas copies this rect
    // (`src/ui/screen.js`) so the two surfaces stay registered — which is what makes a click
    // land on the row the player is looking at.
    canvas.style.position = 'absolute';
    canvas.style.width = `${outW}px`;
    canvas.style.height = `${outH}px`;
    canvas.style.left = `${Math.floor((w - outW) / 2)}px`;
    canvas.style.top = `${Math.floor((h - outH) / 2)}px`;

    renderer.setSize(outW, outH, false);
    sceneRT.setSize(inW, inH);
    bright.setSize(inW >> 1, inH >> 1);
    mips.forEach((m, i) => {
      const w = Math.max(2, (inW >> 1) >> i), h = Math.max(2, (inH >> 1) >> i);
      m.a.setSize(w, h); m.b.setSize(w, h);
    });
    // The frustum *is* the buffer, measured in world units at the one density the whole game
    // draws at. Nothing else sets the zoom; `cameraDistance` only stands the camera back.
    const ppu = Math.max(1, config.pixelsPerUnit);
    camera.left = -inW / (2 * ppu);
    camera.right = inW / (2 * ppu);
    camera.top = inH / (2 * ppu);
    camera.bottom = -inH / (2 * ppu);
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
    u.uToe.value = config.contrastToe;
    brightMat.uniforms.uThreshold.value = config.bloomThreshold;
  }

  let frameCount = 0;
  /** Economy mode's own seam (`ui/screens/economy.js`) — the simulation keeps ticking, only
   *  this stops. `renderer.info.reset()` still runs so `stats()` reports zero draws, exactly
   *  what a paused frame actually costs. */
  let paused = false;

  function render() {
    if (!outW) return;
    renderer.info.reset();
    if (paused) return;
    syncUniforms();
    // Grain does not animate.
    //
    // It used to, and the harness froze the phase so that "same URL, same pixels"
    // (tools/shots/shoot.js) held for a capture. But grain is evaluated per INTERNAL pixel now
    // (see the composite shader), so at `pixelScale: 3` every sample is a 3x3 block of output
    // pixels at full amplitude — and re-rolling all of them every frame is a shimmer over the
    // entire picture that never stops, including on a frame where nothing in the world moves.
    // A fixed per-pixel dither still breaks banding, which is the job, and it costs nothing.
    //
    // The regression baselines do not move: the harness already captured with `timeFrozen`,
    // i.e. `uTime = 0`, which is exactly what this now does in play as well. `?grainAnimate=1`
    // is the A/B, and it keeps the freeze so a capture stays reproducible either way.
    compositeMat.uniforms.uTime.value = (config.grainAnimate && !config.timeFrozen)
      ? (frameCount++ % 64) * 0.017
      : 0;

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
    /** Where the canvas actually sits in the page, for anything that must line up with it. */
    get displayRect() { return { left: canvas.offsetLeft, top: canvas.offsetTop, w: outW, h: outH }; },
    /**
     * Economy mode's render-suppression seam (`ui/screens/economy.js`): `render()` stops
     * doing any GPU work (above), and the canvas itself is hidden — a WebGL canvas keeps
     * showing its *last drawn frame* otherwise, which would read as a frozen, broken world
     * behind the economy card rather than as "not rendering". The simulation is untouched:
     * nothing here pauses a tick, a clock, or an automation.
     */
    setPaused(on) {
      paused = !!on;
      canvas.style.visibility = paused ? 'hidden' : '';
    },
    get paused() { return paused; },
  };
}

/**
 * Fixed 45-degree camera rig (src/core/render.js). Yaw is locked; the camera never rotates,
 * it only follows, with a critically damped spring so grid steps do not read as stutter.
 */
export function makeCameraRig({ camera, config, view = null }) {
  const focus = new THREE.Vector3();
  const target = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  let snapped = false;
  let basis0 = null, basisWarned = false;

  /**
   * World units one internal pixel covers. **The primitive**.
   *
   * It used to be measured — `2 * cameraDistance * tan(fov/2) / internalHeight` — which meant
   * it changed with the size of the window, and everything sized off it changed with it. It is
   * a constant now, and the camera frustum is derived from *it* in `resize()` rather than the
   * other way round. Exact, so `pokemon/field.js`'s magnification comes out at a whole 2 and
   * not at 1.99999997.
   *
   * Orthographic, so there is no "at the focus plane" any more: this is the density at every
   * depth in the frame.
   */
  function unitsPerPixel() {
    return 1 / Math.max(1, config.pixelsPerUnit);
  }

  function recomputeOffset() {
    const pitch = THREE.MathUtils.degToRad(config.cameraPitch);
    const yaw = THREE.MathUtils.degToRad(config.cameraYaw);
    const d = config.cameraDistance;
    // Looking north-ish and down: the camera sits south of and above the focus, and `yaw`
    // orbits that position around the focus at the same fixed pitch — Studio-only, and 0 in
    // the game and every showcase. At 0 this is exactly the old expression: sin(0) is 0, so
    // the X term drops out, and cos(0) is 1, so the Y and Z terms are untouched.
    offset.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d);
  }

  return {
    get focus() { return focus; },
    /**
     * The pixel grid the camera itself snaps to, published so nothing has to re-derive it.
     * `pokemon/field.js` sizes its sprites off this exact number: a sprite grid that is not
     * the world's grid is two grids, and the picture shimmers between them.
     */
    unitsPerPixel,
    /**
     * The zoom ladder: the only three densities at which both sprite art (16 texels/unit) and
     * tile art (32 texels/unit) land on whole pixels. See `config.pixelsPerUnit`.
     */
    PPU: Object.freeze({ wide: 16, normal: 32, close: 64 }),
    /**
     * Framing that fits `cellsWide` across and `cellsDeep` of ground, on **two** knobs.
     *
     * There are two, and conflating them is what the old "solve for a camera distance" code
     * did. `pixelsPerUnit` is the zoom — how big a world unit is, in pixels — and it is a
     * three-rung ladder because it is the thing that has to keep the art on whole texels.
     * `pixelScale` is how many screen pixels one of those pixels occupies, so it decides how
     * much world the buffer holds *at an unchanged density*: at 1280x720, `pixelScale 2` gives
     * a 640-wide buffer and 20 cells, and `pixelScale 1` gives 1280 and 40 — same tiles, same
     * texels, twice the sheet.
     *
     * So detail comes first: hold the highest `pixelsPerUnit` that can be made to fit, and buy
     * the room by widening the buffer rather than by zooming out. Only a showcase should call
     * this — the game itself wants `pixelScale` on the viewport policy, which is what a
     * chunky, legible pixel means on a phone.
     *
     * The ground term is not the screen term: at `cameraPitch` degrees a run of `L` cells in Z
     * covers `L * sin(pitch)` of *screen* height, so the visible depth is the frustum height
     * over `sin(pitch)` — about 1.41x the cells the height alone suggests.
     *
     * @returns {{ppu:number, pixelScale:number}} also applied to config before returning
     */
    fitFraming(cellsWide, cellsDeep = 0) {
      const vw = Math.max(2, Math.floor(view?.displayRect?.w ?? 1920));
      const vh = Math.max(2, Math.floor(view?.displayRect?.h ?? 1080));
      const sinPitch = Math.sin(THREE.MathUtils.degToRad(config.cameraPitch)) || 1;
      const even = (n) => Math.max(2, Math.ceil(n / 2) * 2);
      let best = { ppu: 16, pixelScale: 1 };
      outer:
      for (const ppu of [64, 32, 16]) {
        for (let scale = 6; scale >= 1; scale--) {
          const iw = even(vw / scale), ih = even(vh / scale);
          if (iw > config.maxInternalWidth || ih > config.maxInternalWidth) continue;
          if (iw / ppu >= cellsWide && (!cellsDeep || (ih / ppu) / sinPitch >= cellsDeep)) {
            best = { ppu, pixelScale: scale };
            break outer;
          }
        }
      }
      config.set(best.ppu === config.pixelsPerUnit && best.pixelScale === config.pixelScale
        ? {} : { pixelsPerUnit: best.ppu, pixelScale: best.pixelScale });
      return best;
    },
    setFocus(x, y, z, immediate = false) {
      target.set(x, y, z);
      if (immediate || !snapped) { focus.copy(target); snapped = true; }
    },
    /**
     * Studio-only: orbit the rig to `deg` degrees of yaw around the focus, at the same fixed
     * `cameraPitch`. Nothing in the shipped game or any showcase calls this, so `cameraYaw`
     * stays at its default 0 and `recomputeOffset()`/`update()` keep computing exactly what
     * they compute today.
     *
     * Also resets the debug basis-drift assertion at the bottom of `update()`: that check
     * exists to catch code that quietly rotates the camera basis out from under
     * `pokemon/field.js`'s sprite placement, and a deliberate yaw from here is exactly that
     * rotation, on purpose — without the reset the very next frame would report the change
     * the Studio just asked for as the bug the assertion was written to catch.
     */
    setYaw(deg) {
      config.set({ cameraYaw: deg });
      basis0 = null;
      basisWarned = false;
    },
    update(dt) {
      recomputeOffset();
      // Exponential smoothing that is frame-rate independent.
      const k = 1 - Math.pow(config.cameraDamping, Math.max(dt, 1e-4) * 60);
      focus.lerp(target, Math.min(1, k));

      // Aim by setting the rotation, not by looking at anything.
      //
      // `lookAt(focus.x, focus.y + cameraLookAhead, focus.z)` from `focus + offset` does not
      // aim at `cameraPitch` — the look direction is `(0, lookAhead, 0) - offset`, which at
      // the shipped 1.6 and distance 30 is 42.77 degrees below horizontal, not 45. That
      // mattered because `pokemon/sprites.js` pre-stretches every sprite by `1 / cos(pitch)`
      // to cancel the foreshortening of an upright quad under a tilted camera, and it was
      // cancelling the wrong angle: every sprite in the game was 3.9% too tall and its texels
      // were not square. Setting the rotation makes the pitch exactly what the config says,
      // so the pre-stretch is exact and a sprite texel is a square block of pixels.
      const pitch = THREE.MathUtils.degToRad(config.cameraPitch);
      const yaw = THREE.MathUtils.degToRad(config.cameraYaw);
      camera.rotation.set(-pitch, yaw, 0, 'YXZ');
      camera.position.copy(focus).add(offset);

      // Put the world on a whole internal pixel — AFTER the aim, which is the whole trick.
      //
      // The lerp above is continuous, so without a snap the whole world — tiles and sprites
      // alike — slides by a fraction of a pixel every frame and a NEAREST upscale turns that
      // into a shimmer along every edge. Snapping before the aim did nothing about it back
      // when the aim was a `lookAt`: it re-aimed at the un-snapped focus, so the slide came
      // straight back, and it rotated the supposedly locked basis by a hair every frame —
      // which `pokemon/field.js` reads back to place its sprites, so the shimmer arrived
      // twice. With a fixed rotation the basis is constant for the life of the session and
      // the snap survives into the projection matrix. Two dot products, as before.
      //
      // Under the orthographic camera this one snap grids the **whole frame**. There is no
      // depth divide, so a whole-pixel translation of the camera is a whole-pixel translation
      // of every building, fence, tile and sprite in it, at every depth.
      const upp = config.cameraSnap ? unitsPerPixel() : 0;
      camera.updateMatrixWorld();
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      up.setFromMatrixColumn(camera.matrixWorld, 1);
      if (upp > 0) {
        // `cameraLookAhead` is a world-Y lift of the aim point, which is what put the player
        // low-centre. A world-Y displacement projects onto screen-up as `dy * cos(pitch)`, so
        // it is a translation along `up` — rounded to whole pixels here so the snap below
        // leaves it alone. Shifting `top`/`bottom` instead would be the same arithmetic in a
        // second place, and one of the two would escape the snap.
        const lookAheadPx = Math.round(config.cameraLookAhead * Math.cos(pitch) / upp);
        camera.position.addScaledVector(up, lookAheadPx * upp);
        const dx = camera.position.dot(right) / upp;
        const dy = camera.position.dot(up) / upp;
        camera.position
          .addScaledVector(right, (Math.round(dx) - dx) * upp)
          .addScaledVector(up, (Math.round(dy) - dy) * upp);
        // Republish the moved position: `field.js` reads `matrixWorld` before the renderer
        // gets a chance to refresh it, and a stale one is a whole frame of snap error.
        camera.updateMatrixWorld(true);
      } else {
        camera.position.addScaledVector(up, config.cameraLookAhead * Math.cos(pitch));
        camera.updateMatrixWorld(true);
      }

      // The basis is supposed to be nailed down now. This is the trap for the next person who
      // reaches for `lookAt` — a rotating basis is the bug this rig has already had once, and
      // it is invisible in a still frame.
      if (config.debug) {
        if (basis0) {
          const drift = Math.max(
            right.distanceTo(basis0.right), up.distanceTo(basis0.up));
          if (drift > 1e-6 && !basisWarned) {
            basisWarned = true;
            console.error(`camera basis moved by ${drift} — something is rotating the rig`);
          }
        } else {
          basis0 = { right: right.clone(), up: up.clone() };
        }
      }
    },
    /**
     * Frames a rectangle of the world — used by showcases and the screenshot presets.
     *
     * Zoom is `{ ppu }`, one of 16 / 32 / 64, not a camera distance: the camera is
     * orthographic and standing further back does not make anything smaller. See
     * `config.pixelsPerUnit` for why the ladder has three rungs.
     */
    frame(cx, cz, y = 0, opts = null) {
      if (typeof opts === 'number') {
        throw new TypeError(
          `rig.frame() takes { ppu }, not a distance (got ${opts}). Use { ppu: 16 }, { ppu: 32 } or { ppu: 64 }.`);
      }
      if (opts?.ppu) config.set({ pixelsPerUnit: opts.ppu });
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
