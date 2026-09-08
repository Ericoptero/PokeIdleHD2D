/**
 * Cast shadows for upright sprite cards — trainers, Pokémon, NPCs.
 *
 * ── Why this is not the shadow map ───────────────────────────────────────────────────────
 * Every character in the game is one quad in an `InstancedMesh`, standing upright and facing
 * the camera (`pokemon/field.js`, DECISIONS #18). Putting that mesh in the shadow pass looks
 * like the obvious fix and does not work, for a reason that is geometric rather than a bug:
 *
 *   · leave the card facing the camera and, the moment the sun's azimuth is 90° off the
 *     camera's, the light sees the card **edge on**. A 2-unit-wide sprite occludes a
 *     one-texel line and throws a hairline. 17:30 — the hour with the longest shadows in
 *     the day and the one the critic measured — is exactly that case.
 *   · turn the card to face the light in a `customDepthMaterial` and the caster plane now
 *     crosses the receiver plane along the vertical line through the sprite's origin. Half
 *     of every sprite is then behind its own occluder and self-shadows: a hard vertical
 *     split down the middle of every character in the frame. Pushing the caster clear costs
 *     an offset the size of the sprite's own half-width, which detaches the shadow from
 *     the feet by a full world unit.
 *
 * So the shadow is **projected** instead: the sprite's own silhouette, sheared flat onto the
 * ground along the sun's azimuth, at the length the sun's altitude implies. This is the
 * classic planar projected shadow, and for a scene whose characters are all flat cards on
 * near-flat ground it is strictly better than a shadow map — it cannot self-shadow, it
 * cannot alias, its softness is ours to choose, and it costs one draw call for the whole
 * cast however large the cast is.
 *
 * ── What makes it read as light and not as a decal ──────────────────────────────────────
 *   · It is a **multiply**, not a black overlay. `pokemon`'s contact blob is
 *     `MeshBasicMaterial({ color: 0, opacity: 0.58 })`, which mixes every pixel it covers
 *     toward black and therefore *desaturates* what it crosses — the "flat uniform grey that
 *     DESATURATES what it crosses instead of darkening it warmly" note. A multiply keeps the
 *     surface's own albedo and its own hue.
 *   · The multiplier is not a constant. `environment` computes, from the lights it just set,
 *     the exact per-channel ratio `fill / (fill + sun)` that a flat piece of ground takes
 *     when the sun is removed from it, and hands it in as `uShade`. So the sprite shadow is
 *     the *same* depth and the *same* colour as the shadow the shadow map casts from a bench
 *     one cell away, at every hour, with no second set of numbers to keep in sync.
 *   · The blur widens with distance from the feet (`uSoft`), which is contact hardening: the
 *     silhouette is crisp where the character touches the ground and dissolves at the far
 *     end. A constant penumbra is the tell that a shadow was paint.
 *
 * ── How it finds its subjects ───────────────────────────────────────────────────────────
 * By *shape*, not by name: an `InstancedMesh` whose geometry carries an `aUvRect` instanced
 * attribute is a sprite field showing atlas frames (the attribute is the contract), and its
 * material's `map` is the atlas. The mirror mesh shares both buffers by reference, so it
 * follows the cast for free and uploads nothing of its own.
 */

/** Local-space quad the sprite field uses: x ∈ [−0.5, 0.5], y ∈ [0, 1], origin at the feet. */
const VERT = /* glsl */`
attribute vec4 aUvRect;
varying vec2 vUv;
varying vec4 vRect;
varying float vRun;
uniform vec2 uDir;        // horizontal unit vector the shadow runs along
uniform float uLen;       // ground units of run per world unit of height
uniform float uLift;      // world units above the instance origin — see the note in JS

void main() {
  vRect = aUvRect;
  vUv = aUvRect.xy + uv * aUvRect.zw;

  // instanceMatrix is composed by pokemon/field.js as (translation = feet, no rotation,
  // scale = (w, h, 1)), so its columns give the card's world size without a decompose.
  vec3 org = instanceMatrix[3].xyz;
  float sw = length(instanceMatrix[0].xyz);
  float sh = length(instanceMatrix[1].xyz);

  vec2 side = vec2(uDir.y, -uDir.x);
  float up = position.y * sh;             // height up the card this vertex sits at
  float run = up * uLen;                  // how far its shadow lands from the feet
  vRun = position.y;

  vec3 p = vec3(
    org.x + side.x * position.x * sw + uDir.x * run,
    org.y + uLift,
    org.z + side.y * position.x * sw + uDir.y * run);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec2 vUv;
varying vec4 vRect;
varying float vRun;
uniform sampler2D uMap;
uniform vec3 uShade;      // per-channel multiplier a shadowed piece of ground takes
uniform vec2 uTexel;      // 1 / atlas size
uniform float uSoft;      // blur radius in texels at the far end of the shadow
uniform float uFade;      // how much of the shadow survives at the far end

/**
 * Coverage, clamped to the frame's own rect so a tap never bleeds into its neighbour.
 * The atlas is packed with flipY off, so a frame's dv is NEGATIVE and the rect's second
 * corner is above its origin in v; min/max rather than the corners themselves, because
 * clamp() with minVal > maxVal is undefined in GLSL and returned garbage here.
 */
float tap(vec2 off) {
  vec2 c0 = vRect.xy, c1 = vRect.xy + vRect.zw;
  vec2 uv = clamp(vUv + off, min(c0, c1), max(c0, c1));
  return texture2D(uMap, uv).a;
}

void main() {
  // Contact hardening: one tap at the feet, a widening cross further out. Five taps is
  // enough because the silhouette is a hard cutout — what the eye reads is the *edge*
  // getting fuzzier with distance, not the number of samples.
  float r = uSoft * vRun;
  vec2 dx = vec2(uTexel.x * r, 0.0);
  vec2 dy = vec2(0.0, uTexel.y * r);
  float a = tap(vec2(0.0)) * 0.36
          + (tap(dx) + tap(-dx) + tap(dy) + tap(-dy)) * 0.16;

  // Alpha in the atlas is a hard cutout, so smoothstep gives the resampled coverage a
  // gradient to live in instead of a staircase.
  a = smoothstep(0.18, 0.66, a);
  a *= mix(1.0, uFade, vRun);
  if (a < 0.004) discard;

  gl_FragColor = vec4(mix(vec3(1.0), uShade, a), 1.0);
}
`;

/**
 * @param {typeof import('three')} THREE
 * @param {THREE.Scene} scene
 */
export function makeCastShadows(THREE, scene) {
  const group = new THREE.Group();
  group.name = 'env:castShadows';
  scene.add(group);

  /** @type {{src:THREE.InstancedMesh, mesh:THREE.InstancedMesh, mat:THREE.ShaderMaterial}[]} */
  const rigs = [];
  const seen = new WeakSet();
  let scanCountdown = 0;

  /** A sprite field is an InstancedMesh whose geometry carries the atlas-frame attribute. */
  function isSpriteField(o) {
    return o.isInstancedMesh
      && o.geometry?.getAttribute?.('aUvRect')
      && o.material?.map?.image
      && !seen.has(o);
  }

  function attach(src) {
    seen.add(src);
    const geo = new THREE.BufferGeometry();
    const q = src.geometry;
    // Shared by reference on purpose: `position`/`uv` are static, and `aUvRect` is rewritten
    // by the sprite field every frame. One upload feeds both meshes.
    geo.setAttribute('position', q.getAttribute('position'));
    geo.setAttribute('uv', q.getAttribute('uv'));
    geo.setAttribute('aUvRect', q.getAttribute('aUvRect'));
    geo.setIndex(q.getIndex());

    const img = src.material.map.image;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uMap: { value: src.material.map },
        uShade: { value: new THREE.Vector3(0.3, 0.34, 0.45) },
        uDir: { value: new THREE.Vector2(0, 1) },
        uTexel: { value: new THREE.Vector2(1 / (img.width || 512), 1 / (img.height || 512)) },
        uLen: { value: 0.6 },
        // The sprite field drops its quad by FOOT_PAD_TEXELS (2 of 16, so 0.125 world units)
        // so a walking frame's two empty rows of art land on the ground rather than above it.
        // The instance origin is therefore *below* the surface, and a shadow laid at it is
        // inside the paving slab and fails the depth test everywhere — the same failure the
        // lamp pool shipped with once. 0.15 puts it back on the floor with 0.025 to spare.
        uLift: { value: 0.15 },
        uSoft: { value: 2.6 },
        uFade: { value: 0.42 },
      },
      transparent: true,
      // dst * src — see the header. `ZeroFactor` on the destination means the fragment
      // *replaces* the ground with `ground × shade`, which is what removing a light does.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    });

    const mesh = new THREE.InstancedMesh(geo, mat, src.instanceMatrix.count);
    // The same attribute object, so the sprite field's own upload serves this mesh too and
    // the shadow can never be a frame behind the character it belongs to.
    mesh.instanceMatrix = src.instanceMatrix;
    mesh.name = `${src.name}:cast`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.count = 0;
    group.add(mesh);
    rigs.push({ src, mesh, mat });
  }

  return {
    /** Sprite fields currently mirrored. Surfaced as `environment.castShadows()`. */
    count: () => rigs.length,

    /**
     * @param {{x:number,y:number,z:number}} sunDir  world → light, already floored in altitude
     * @param {{r:number,g:number,b:number}} shade   per-channel `fill / (fill + sun)`
     * @param {number} strength  0..1 master, so a preset can dial the whole effect
     * @param {boolean} [off]    verification toggle
     */
    update(sunDir, shade, strength, off) {
      if (--scanCountdown <= 0) {
        scanCountdown = 10;
        scene.traverse((o) => { if (isSpriteField(o)) attach(o); });
      }
      if (!rigs.length) return;

      const hx = -sunDir.x, hz = -sunDir.z;
      const hl = Math.hypot(hx, hz) || 1;
      const dx = hx / hl, dz = hz / hl;
      // Ground run per unit of height. Real physics runs to 17× at the elevation floor, which
      // would throw a character's shadow across the whole plaza and out of the frame; past
      // 1.5× the run is compressed so a low sun still reads as "long" without the shadow
      // becoming the composition. Ref 03's Poochyena throw about three times their height.
      const raw = sunDir.y > 1e-3 ? Math.sqrt(1 - sunDir.y * sunDir.y) / sunDir.y : 12;
      const len = Math.min(3.4, raw <= 1.5 ? raw : 1.5 + (raw - 1.5) * 0.42);

      for (const rig of rigs) {
        const n = off ? 0 : rig.src.count;
        rig.mesh.count = n;
        rig.mesh.visible = n > 0;
        if (!n) continue;
        const u = rig.mat.uniforms;
        // The atlas texture is replaced outright when a new sheet is packed, so the mirror
        // re-reads it rather than caching the object it saw at attach time.
        const map = rig.src.material.map;
        if (map && u.uMap.value !== map) {
          u.uMap.value = map;
          u.uTexel.value.set(1 / (map.image?.width || 512), 1 / (map.image?.height || 512));
        }
        u.uDir.value.set(dx, dz);
        u.uLen.value = len;
        // A long shadow is a soft one: the penumbra of a real sun grows with the distance
        // light travels past the occluder, and at a grazing sun that is most of the frame.
        u.uSoft.value = 0.9 + 1.9 * Math.min(1, len / 3.4);
        u.uFade.value = 0.52 - 0.20 * Math.min(1, len / 3.4);
        const k = Math.max(0, Math.min(1, strength));
        u.uShade.value.set(
          1 - (1 - shade.r) * k,
          1 - (1 - shade.g) * k,
          1 - (1 - shade.b) * k);
      }
    },

    dispose() {
      for (const rig of rigs) {
        // `position`/`uv`/`aUvRect` and `instanceMatrix` belong to the sprite field; only the
        // geometry wrapper and this material are ours to free.
        rig.mesh.geometry.dispose();
        rig.mat.dispose();
      }
      rigs.length = 0;
      scene.remove(group);
    },
  };
}
