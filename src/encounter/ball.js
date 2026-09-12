/**
 * ball.js — the thrown ball, as authored pixel art.
 *
 * A capture is the one moment this module has that is genuinely a *picture* rather than a
 * number, so it uses authored art. The ball is a **16x16 pixel sprite**, authored below one
 * character at a time, blown up through the same nearest-filter path everything else in the
 * frame goes through.
 *
 * ## The grid
 *
 * `BALL_ART` is the silhouette: a 12 px circle padded into a 16 px frame, a **one**-row band
 * across the middle, and a 4x2 button straddling it. Colour is *symbolic* — `T` is "the
 * top", `H` "the lit part of the top", `t` "the shaded part" — so the same sixteen rows
 * draw all eighteen of `economy`'s balls by swapping a three-entry palette. That is how the
 * real sprites are built too, and it is why a Dusk Ball and a Great Ball differ by a table
 * row rather than by another PNG.
 *
 * ## Scale, and why the quad is stretched
 *
 * Sprites are 16 texels per world unit and their quads are multiplied by
 * `1/cos(cameraPitch)` because a vertical world unit only covers `cos(45°)` of the screen
 * height it would cover face-on. So the 16 px frame is exactly one world unit across and
 * `1/cos(45°) = 1.414` units tall, which lands as a square block of pixels on screen, and
 * the 12 px ball inside it reads 0.75 tiles wide with every texel still on the grid.
 *
 * ## Nothing here reads a clock
 *
 * Every method takes a phase in `[0,1]`, or a shake index. The caller owns the timeline and
 * drives it off `simTime`/sim steps, so a frozen scene renders the same frame every time
 * and a screenshot of the moment the ball is in the air is reproducible.
 */

/**
 * The ball, drawn as a **12 px circle inside a 16 px frame**.
 *
 * The frame size is what fixes the world scale: sprites are 16 texels per world unit
 *, so a 16 px quad is exactly one tile and every texel lands on the pixel
 * grid — but a ball a whole tile across reads as a boulder next to a two-tile-tall Pokemon.
 * Padding the art instead of shrinking the quad gives a ball 0.75 tiles wide *and* keeps the
 * texels square, which shrinking the mesh would not.
 *
 * `.` transparent, `o` outline, `T/H/t` top / its highlight / its shade, `B` band,
 * `k/W` button ring and lens, `w/s` lower shell and its shade.
 */
const BALL_ART = [
  '................',
  '................',
  '......oooo......',
  '....ooTTTToo....',
  '...oHHTTTTtto...',
  '...oHHTTTTtto...',
  '..oHTTTkkkkTto..',
  '..oBBBkWWkBBBo..',
  '..owwwkWWkwwso..',
  '..owwwkkkkwwso..',
  '...owwwwwwsso...',
  '...owwwwwssso...',
  '....oowwssoo....',
  '......oooo......',
  '................',
  '................',
];

/**
 * The **"!" bubble is gone**, and so is the grass that used to part under it.
 *
 * Both were the vocabulary of a reveal: 16 px of balloon that said *something is happening
 * here, to that one*, and nine leaves that said *it came out of there*. The field encounter implementation removed
 * the thing they were describing — the creature was already walking the map and the party
 * walked up to it, so there is no arrival to caption. What names the wild now is the plate over
 * its head, and what says "you may throw" is that plate's empty HP bar.
 *
 * `shimmer()` below is deliberately kept: a shiny Azurill is green on green grass, and that
 * ring is the only thing that makes one legible. It is identity, not a transition.
 */

/**
 * How wide one sparkle quad is, in world units.
 *
 * Round 1 drew them at 0.55 — 55 screen px at `pixelScale 3`, which is two thirds of the
 * ball and wider than a Pokemon's head. In `mode=shiny` five of them sat *on top of* the
 * shiny the ring exists to make legible. Now that the core actually clips to white and
 * blooms (see `sparkMat.color` below), the halo carries the read and the quad does not have
 * to: 0.34 is a star rather than a plate, and ten of them still ring a 2-unit sprite.
 */
const SPARK_SIZE = 0.34;



/** A four-point sparkle for the capture burst — the same 16 px grid, drawn at 8x8. */
const SPARK_ART = [
  '...o....',
  '..oWo...',
  '.oWWWo..',
  'oWWWWWo.',
  '.oWWWo..',
  '..oWo...',
  '...o....',
  '........',
];

/**
 * Palettes, keyed by `economy`'s item ids. `T` top, `H` its highlight, `t` its shade, and
 * `w`/`s` the lower shell — a Premier Ball is white all the way round, a Luxury Ball is
 * black with gold, and the rest follow the mainline's colour language.
 */
const PALETTES = {
  pokeball:    { T: '#e8402c', H: '#ff7a63', t: '#a81f18' },
  premierball: { T: '#f6f6f2', H: '#ffffff', t: '#c6c6c0', o: '#7d1f1f' },
  greatball:   { T: '#2f6fd0', H: '#7fb4ff', t: '#1e4a94' },
  ultraball:   { T: '#2b2b33', H: '#f2c33c', t: '#16161c' },
  masterball:  { T: '#7b3fbf', H: '#c79bf5', t: '#4d2280' },
  duskball:    { T: '#1f7a5e', H: '#3fbf90', t: '#12503d' },
  quickball:   { T: '#3f7fd6', H: '#f4d14a', t: '#26558f' },
  netball:     { T: '#2aa5a5', H: '#6fe0dc', t: '#1a6d6d' },
  diveball:    { T: '#2f8fd0', H: '#8bdcff', t: '#1c5a86' },
  timerball:   { T: '#dcdcdc', H: '#ffffff', t: '#9c9ca4', o: '#3a1414' },
  repeatball:  { T: '#e8a02c', H: '#ffd066', t: '#a86a18' },
  luxuryball:  { T: '#1a1a22', H: '#d8b45a', t: '#0d0d12' },
  healball:    { T: '#f090c0', H: '#ffcbe4', t: '#b05c8a' },
  nestball:    { T: '#9fd04a', H: '#d3f582', t: '#6d9128' },
  levelball:   { T: '#e0641f', H: '#ffa761', t: '#96400f' },
  moonball:    { T: '#2b3f7a', H: '#f0e08c', t: '#1a2750' },
  fastball:    { T: '#e8c62c', H: '#fff29a', t: '#a8901c' },
  heavyball:   { T: '#4a5a72', H: '#9db4d6', t: '#2c3648' },
};

/**
 * The greys, and the one table edit round 2 is actually about.
 *
 * Round 1 painted the outline `#14141c`, the equator band `#1d1d24` and the button ring
 * `#2a2a33` — three names for the same colour. Pushed through this scene's grade (AgX at
 * `exposure 0.355`, then `contrast 1.32`) all three land on literal (0,0,0), and with a
 * **two**-row band plus a two-row ring on a ball only twelve texels tall that was 56 of the
 * 112 filled texels: measured at noon,
 * 50.4 % of the ball's own pixels were exactly black. A Great Ball read as a blue cap over
 * a domino mask.
 *
 * So the band is **one** row now (`BALL_ART` above), the button straddles it the way a real
 * one does, and the three greys are separated by value rather than by name: the outline
 * stays the darkest thing on the sprite because an outline should be, the band is a clear
 * step above it and the ring a clear step above that. Only the outline is allowed to clip.
 */
export const SHARED = { o: '#2b2b36', B: '#4d4d5c', k: '#74747f', W: '#ffffff', w: '#ececeb', s: '#b0b3bb' };

/** Draws one 16x16 grid into a canvas at 1 texel per pixel. */
/**
 * Pixel art to a canvas — one grid, one palette swap, one nearest-filtered texture . Once
 * shared with `encounter/strikes.js`'s own move effects too; that file is gone (replaced by shader VFX), so this is the ball's own helper again.
 */
export function paint(art, palette, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const g = canvas.getContext('2d', { willReadFrequently: false });
  g.imageSmoothingEnabled = false;
  for (let y = 0; y < art.length; y++) {
    const row = art[y];
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === '.') continue;
      const colour = palette[c] ?? SHARED[c];
      if (!colour) continue;
      g.fillStyle = colour;
      g.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

export function texture(THREE, canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Ball ids this file draws with a palette of their own; the rest fall back to a Poke Ball. */
export function paletteFor(ballId) {
  return PALETTES[ballId] ? ballId : 'pokeball';
}

/**
 * The whole capture set: one ball quad, one sparkle instancer, one contact shadow.
 *
 * Three draw calls at most, and only while an encounter is on screen — `hide()` takes the
 * group out of the frame entirely rather than scaling it to zero, so an idle scene pays
 * nothing for the ball existing.
 */
export function makeBallSprite(THREE, ctx, { sparks = 10 } = {}) {
  const pitch = ctx.config.cameraPitch;
  const stretch = 1 / Math.cos((pitch * Math.PI) / 180);

  const group = new THREE.Group();
  group.name = 'encounter:ball';
  group.visible = false;

  // --- the ball -------------------------------------------------------------
  const geo = new THREE.PlaneGeometry(1, stretch);
  // The same normal `pokemon/field.js` gives its sprites: mostly up so a cutout takes the
  // key light of the ground it is over, with enough lean to keep some modelling.
  {
    const n = geo.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 0.78, 0.63);
    n.needsUpdate = true;
  }
  const textures = new Map();
  const texFor = (id) => {
    const key = paletteFor(id);
    if (!textures.has(key)) textures.set(key, texture(THREE, paint(BALL_ART, PALETTES[key], 16)));
    return textures.get(key);
  };
  const material = new THREE.MeshLambertMaterial({
    map: texFor('pokeball'),
    transparent: false,
    alphaTest: 0.5,               // cutout, so the ball stays in the opaque pass and sorts
    side: THREE.DoubleSide,       // it spins: the far face has to draw too
    fog: true,
    name: 'encounter:ball',
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'encounter:ball';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);



  // --- sparkles -------------------------------------------------------------
  const sparkGeo = new THREE.PlaneGeometry(SPARK_SIZE, SPARK_SIZE * stretch);
  // The star is painted in **two** values, and that is where the halo comes from.
  // `sparkMat.color` multiplies the whole texture, so a diamond drawn in one flat colour
  // either clips everywhere or nowhere and there is no falloff to bloom. At 0.55 of white the
  // fringe lands at 3.0 in the HDR target — above every keyframe's bloom threshold, below the
  // level that clips after AgX — so the core reads as white and the ring reads as light.
  const sparkTex = texture(THREE, paint(SPARK_ART, { W: '#ffffff', o: '#8f8878' }, 8));
  const sparkMat = new THREE.MeshBasicMaterial({
    map: sparkTex, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    toneMapped: false, fog: false, name: 'encounter:sparkle',
  });
  // Brighter than white, on purpose — and round 1's number was fitted against a threshold
  // this scene never runs at.
  //
  // The composite is `scene + bloom*uBloom → *exposure → AgX → grade` (core/render.js) and
  // the bright pass keeps `(l - uThreshold)/l` of a pixel. The comment here used to cite
  // `config.bloomThreshold` 0.72, but `environment` drives that from its own keyframes:
  // **1.15 at noon, 1.8 at golden hour, 2.6 at night**. A luma of 2.44 (which is what
  // (2.6, 2.45, 1.9) is) therefore kept 53 % of itself at noon against a bloom *strength*
  // of only 0.30, and literally **zero** at night, where the threshold is above it. There
  // was no halo to measure: the skirt/core ratio came out 0.01–0.02 and the brightest 400
  // sparkle pixels averaged (246, 215, 186) — cream, never white.
  //
  // 5.6 clears every keyframe in `presets.js` including night's 2.6 (the pass keeps 54 %
  // there and 79 % at noon), and `5.6 * 0.355` at noon saturates AgX, so the *core* clips
  // to white and the sodium warmth lives in the skirt where a real bloom puts it. Neutral
  // rather than warm on purpose as well: noon runs `saturation 1.64`, which pushes any tint
  // in the core further from white, and that is exactly what made the diamonds read cream.
  sparkMat.color.setRGB(5.6, 5.5, 5.15);
  const sparkMesh = new THREE.InstancedMesh(sparkGeo, sparkMat, sparks);
  sparkMesh.name = 'encounter:sparkles';
  sparkMesh.frustumCulled = false;
  sparkMesh.renderOrder = 5;
  sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparkMesh.count = 0;
  group.add(sparkMesh);



  // --- contact shadow -------------------------------------------------------
  // The ball's own, not a sprite's: `pokemon`'s blob belongs to `pokemon`'s field and this
  // quad is not in it. Without one the ball hangs in the air on the ground frames.
  const blobGeo = new THREE.PlaneGeometry(0.95, 0.95);
  blobGeo.rotateX(-Math.PI / 2);
  const blobCanvas = document.createElement('canvas');
  blobCanvas.width = blobCanvas.height = 32;
  {
    const g = blobCanvas.getContext('2d');
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    // A tight core with a short skirt, not a wide blur. At two internal pixels per texel a
    // 15-level gradient spread over 50 screen pixels is invisible; the same darkness packed
    // into a disc two thirds that wide is a shadow. Measured against `blob.visible = false`.
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.62, 'rgba(255,255,255,0.97)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  const blobTex = new THREE.CanvasTexture(blobCanvas);
  blobTex.needsUpdate = true;
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTex, color: 0x000000, transparent: true, opacity: 0.88, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    toneMapped: false, fog: true, name: 'encounter:ball-shadow',
  });
  const blob = new THREE.Mesh(blobGeo, blobMat);
  blob.renderOrder = 2;
  blob.visible = false;
  group.add(blob);

  ctx.three.scene.add(group);

  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const camPos = new THREE.Vector3();

  /**
   * How much to shrink the sprite so a *lifted* ball keeps the texel size it had on the
   * ground — the arc's half of `pixelExactDistance()`.
   *
   * The showcase frames at the distance where one sprite texel is exactly two internal
   * pixels, and that is only true at one distance. A perspective camera
   * scales as `1/d`, and this camera is pitched 45 degrees down, so lifting the ball 1.8
   * units up the arc walks it 1.27 units *closer* — about 6 % nearer at the framing this
   * module shoots. Measured on round 1's `c01`: ground sprites ran a constant 6 screen px
   * per texel while the ball at apex ran 7.08 across and 7.33 down, so its texel runs came
   * out 6/7/9/12 px and its outline stepped raggedly at 8x.
   *
   * `d / d0` is exactly the factor that cancels it. Six per cent of size is invisible; six
   * per cent of a *texel* is the difference between a pixel-art sprite and a resampled one,
   * which is the same trade used for `wide`, made the other way because
   * here it costs nothing to read.
   */
  function gridScale(x, y, z, groundY) {
    const cam = ctx.three.camera;
    if (!cam) return 1;
    cam.getWorldPosition(camPos);
    const d = Math.hypot(camPos.x - x, camPos.y - y, camPos.z - z);
    const d0 = Math.hypot(camPos.x - x, camPos.y - groundY, camPos.z - z);
    return d0 > 1e-3 ? d / d0 : 1;
  }

  /**
   * The last airborne placement, kept so `refit()` can redo its scale.
   *
   * `gridScale` reads the camera, and the camera is a critically damped spring that is still
   * settling while `advanceToStage()` walks the animation forward — so a scale computed at
   * the moment `arc()` ran is computed against a camera several units from where the shutter
   * finds it. Measured: the scale came out **1.0012** instead of 0.946, i.e. the correction
   * did nothing at all, and the frozen frame kept it because a frozen scene never calls
   * `arc()` again. So the correction is re-applied per rendered frame instead.
   */
  let airborne = null;


  /** Places the ball, rolled by `roll` radians about the view axis. */
  function place(x, y, z, roll = 0, scale = 1) {
    group.visible = true;
    mesh.visible = true;
    mesh.position.set(x, y + (stretch * scale) / 2, z);
    mesh.quaternion.setFromAxisAngle(zAxis, roll);
    mesh.scale.setScalar(scale);
  }



  /**
   * The contact blob, on the surface the ball is actually over.
   *
   * `y` is a *surface*, not the soil: a cell of `tall_grass` stands 0.625 units proud of its
   * own base (measured off the pack through `tiles.find`), so a blob laid on the soil at
   * `+0.02` is inside the blades and every fragment of it fails the depth test. Round 1 did
   * exactly that and the one cue that sells "in the air" in a still frame was absent from the
   * frame whose whole job is to be that still — at 4x on `c01` there is no darkening anywhere
   * under the ball. The caller passes the top of the cover; a shadow on the tops of the grass
   * is where a real one would land anyway.
   */
  function shadow(x, y, z, size = 1) {
    blob.visible = size > 0.01;
    blob.position.set(x, y + 0.02, z);
    blob.scale.set(size, 1, size);
    blobMat.opacity = 0.88 * (0.55 + 0.45 * Math.min(1, size));
  }

  return {
    group,
    /** Which ball is in the air. Swaps the texture, nothing else. */
    setBall(ballId) { material.map = texFor(ballId); material.needsUpdate = true; },

    /**
     * The throw: a parabola from `from` to `to`, `t` in [0,1], spinning three times on the
     * way. Height is proportional to the distance so a long throw arcs higher.
     */
    arc(from, to, t, groundY = to.y, shadowY = groundY) {
      const k = Math.min(1, Math.max(0, t));
      const dx = to.x - from.x, dz = to.z - from.z;
      const span = Math.hypot(dx, dz);
      // A flat arc, not a lob. `0.9 + 0.35·span` put the apex three world units up on a
      // four-tile throw, which at a 45-degree camera lifts the ball a third of the frame
      // clear of both the thrower and the target and leaves it floating in empty grass with
      // nothing to read it against.
      const lift = 0.45 + span * 0.14;
      const x = from.x + dx * k;
      const z = from.z + dz * k;
      const y = from.y + (to.y - from.y) * k + lift * 4 * k * (1 - k);
      // **No spin.** A thrown ball that rotates freely is what the mainline animates, and it
      // is wrong here: at two internal pixels per sprite texel a rotated 16 px sprite is
      // resampled off its own grid. Measured on screen at 6x: the first cut of this file
      // spun the ball three times on the way over and the shutter caught it at 90 degrees,
      // where it read as an unidentifiable black lump with a blue corner. Every other sprite
      // in this game is axis-aligned for exactly that reason, and an arc
      // alone carries the throw perfectly well.
      airborne = { x, y, z, groundY };
      place(x, y, z, 0, gridScale(x, y, z, groundY));
      // On the GROUND, under the ball — not at the ball's own height, which is where the
      // first shot of this round put it: the blob then drew as a grey ellipse wrapped round
      // the ball itself and the two together read as one unrecognisable blob.
      // Tighter and fainter the higher the ball flies, which is what sells the arc.
      const high = Math.max(0, y - groundY);
      shadow(x, shadowY, z, Math.max(0.45, 0.85 - high * 0.14));
      sparkMesh.count = 0;
    },

    /**
     * On the ground, wobbling. `shake` counts completed wobbles and `t` runs 0..1 through
     * the current one; a wobble is one full left-right sweep, which is what the mainline
     * animates and what makes three of them read as "nearly".
     */
    rest(at, shake, t) {
      airborne = null;
      const k = Math.min(1, Math.max(0, t));
      // A wobble is a NUDGE, not a tilt.
      //
      // Rotating the quad is what the mainline animates and it is wrong at this scale: the
      // ball is 12 texels across drawn at two internal pixels per texel, so the 19-degree
      // roll this started as resampled every texel off its own grid and came out as a smeared
      // lump at 5x. Sliding it two whole texels left and right instead keeps every
      // pixel square — which is the same reason we keep sprites axis-aligned —
      // and still reads unmistakably as a ball fighting to stay shut.
      // Three texels, not two. At two the extreme of the sweep is 2/16 of a world unit —
      // 27 screen px at the framing this module now shoots — against a ball 116 px wide, so a
      // frozen frame anywhere in the wobble looked exactly like a ball standing still. Three
      // is the widest lean that still keeps the whole ball inside the cell it fell into.
      const nudge = shake < 0 ? 0 : Math.round(Math.sin(k * Math.PI * 2) * 3) / 16;
      const hop = shake < 0 ? 0 : Math.max(0, Math.sin(k * Math.PI)) * 0.06;
      place(at.x + nudge, at.y + hop, at.z, 0, 1);
      shadow(at.x, at.y, at.z, 0.62 - hop);
      sparkMesh.count = 0;
    },

    /**
     * The shiny shimmer: a slow ring of sparkles around a Pokemon that has just risen.
     *
     * The mainline announces a shiny with exactly this, and here it is doing real work as
     * well as being faithful. A shiny Azurill is *green* against a green field and a shiny
     * Murkrow is dark on dark; the first `mode=shiny` shot of this round had the rarest
     * thing in the game as an unreadable smudge in the grass (`00-shiny-lost.png`). The ring
     * is what makes the rarity legible at a glance, which is what it is for in the real game
     * too.
     *
     * `phase` is a step count, not a clock — one turn every 40 sim steps.
     */
    shimmer(at, phase) {
      airborne = null;
      group.visible = true;
      mesh.visible = false;
      blob.visible = false;
      const n = sparks;
      const spin = (phase / 40) * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + spin;
        const r = 0.86 + 0.1 * Math.sin(spin * 2 + i);
        pos.set(at.x + Math.cos(a) * r, at.y + 0.95 + Math.sin(a) * r * 0.72, at.z - 0.02);
        // Each spark breathes on its own beat, so the ring twinkles instead of pulsing as
        // one object.
        scl.setScalar(0.72 + 0.5 * Math.max(0, Math.sin(spin * 3 + i * 1.7)));
        m.compose(pos, q.identity(), scl);
        sparkMesh.setMatrixAt(i, m);
      }
      sparkMesh.count = n;
      sparkMesh.instanceMatrix.needsUpdate = true;
      sparkMat.opacity = 0.9;
    },


    /**
     * The click: sparkles thrown outward from the ball, `t` in [0,1]. Deterministic — the
     * angles are fixed fractions of a turn, not a roll, so the burst is the same picture
     * every replay.
     */
    burst(at, t, { keepBall = true } = {}) {
      airborne = null;
      const k = Math.min(1, Math.max(0, t));
      if (keepBall) place(at.x, at.y, at.z, 0, 1);
      else mesh.visible = false;
      shadow(at.x, at.y, at.z, keepBall ? 0.62 : 0);
      const n = sparks;
      // Thrown WIDE and drawn small. The first cut kept ten 0.75-unit stars inside a
      // one-unit ring: at 0.28 of the way through the burst they overlapped into a single
      // pale blob sitting on the ball, which is a worse picture than no burst at all. The
      // stars have to be further apart than they are big for the eye to count them.
      const spread = 0.75 + k * 2.6;
      const fade = 1 - k;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.31;
        const r = spread * (0.75 + 0.25 * ((i % 3) / 2));
        pos.set(at.x + Math.cos(a) * r, at.y + 0.7 + Math.sin(a) * r * 0.72, at.z);
        scl.setScalar(Math.max(0.001, 0.6 + 0.5 * fade));
        m.compose(pos, q.identity(), scl);
        sparkMesh.setMatrixAt(i, m);
      }
      sparkMesh.count = n;
      sparkMesh.instanceMatrix.needsUpdate = true;
      // Held near-opaque for most of the burst and dropped only at the end. Fading linearly
      // from the first frame blended white stars 34 % into green grass, which is grey.
      sparkMat.opacity = Math.min(1, fade * 2.2);
    },

    hide() {
      airborne = null;
      group.visible = false;
      mesh.visible = false;
      blob.visible = false;
      sparkMesh.count = 0;
    },

    /**
     * Re-apply the airborne pixel-grid scale against the camera as it is *now*.
     *
     * Called once per rendered frame from the module's `lateFrame` hook (moved
     * from `frame` so this runs after the camera rig has actually updated). It is a no-op unless the
     * ball is in the air, and it reads nothing but the camera — so a frozen scene stays
     * deterministic (the camera spring converges to the same place from the same URL) while a
     * moving one keeps the ball's texels on the grid as the camera follows.
     */
    refit() {
      if (!airborne) return;
      const a = airborne;
      place(a.x, a.y, a.z, 0, gridScale(a.x, a.y, a.z, a.groundY));
    },

    /** For the showcase's own readout: how many textures the palette actually built. */
    stats: () => ({ palettes: textures.size, sparks }),

    dispose() {
      ctx.three.scene.remove(group);
      geo.dispose(); material.dispose();
      sparkGeo.dispose(); sparkMat.dispose(); sparkTex.dispose();
      blobGeo.dispose(); blobMat.dispose(); blobTex.dispose();
      for (const t of textures.values()) t.dispose();
      textures.clear();
    },
  };
}
