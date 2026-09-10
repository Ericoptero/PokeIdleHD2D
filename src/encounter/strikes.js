/**
 * strikes.js — what a move looks like when it lands.
 *
 * The brief asks that attacks "visually show one Pokémon hitting or affecting the other" with
 * "modern, polished animations based on their move and elemental type". There are 721 moves in
 * the shipped table, so the thing that has to be authored is not 721 animations: it is
 * **eighteen elemental looks crossed with three delivery shapes**, which is twenty-one pieces
 * and covers every move including ones added later.
 *
 * ## Why it lives in `encounter`
 *
 * `battle` is arithmetic and holds no `three` (§5.17). `ui` is a 2-D canvas. `pokemon/field.js`
 * owns the sprite instancers and is generic. `encounter` already stages the duel — the wild
 * lands on its slot cell and the party's Pokémon stands one step away — and already ships 3-D
 * pixel-art VFX in `ball.js`. This is that file's sibling and shares its helpers.
 *
 * ## The rules it inherits from `ball.js`
 *
 * **Never a coloured primitive** (ARCHITECTURE §9): every quad here is a pixel-art grid painted
 * to a canvas and sampled `NearestFilter`, the same path the ball and the sprites take. And
 * **nothing reads a clock** — every method takes a phase in `[0,1]` or a sim step, so a frozen
 * frame is reproducible and a screenshot of the moment a Water Gun lands is the same picture
 * twice (DECISIONS #14, #79).
 */

import { paint, texture, SHARED } from './ball.js';

/** Physical / special / status, as `battle/moves.js` numbers them. */
const STATUS_CATEGORY = 0;
const PHYSICAL_CATEGORY = 1;

/**
 * The **impact**: a four-armed burst, drawn as **outline and arms rather than a filled disc**.
 *
 * The first cut was a solid block of core colour and it read as a pale wash over the creature
 * it landed on — because the bloom threshold is 0.72 at noon and a shape whose whole silhouette
 * is above it stops being a shape. `ball.js` recorded losing a round to exactly this. The
 * silhouette is mostly `o` (the shared dark outline, far below the threshold) with thin `E`
 * arms and a **two-pixel** `C` core, so the bloom has something small and bright to catch and
 * the outline keeps the form readable underneath it.
 */
const IMPACT_ART = [
  '.......oo.......',
  '......o..o......',
  '......o..o......',
  '.....o.EE.o.....',
  '....o..EE..o....',
  '..oo..oEEo..oo..',
  '.o..oEE..EEo..o.',
  'o..oEE.CC.EEo..o',
  'o..oEE.CC.EEo..o',
  '.o..oEE..EEo..o.',
  '..oo..oEEo..oo..',
  '....o..EE..o....',
  '.....o.EE.o.....',
  '......o..o......',
  '......o..o......',
  '.......oo.......',
];

/**
 * The **bolt**: a leading head with a tail, drawn pointing east and rotated by the caller.
 * Asymmetric on purpose — a symmetrical projectile has no direction and reads as a dropped
 * sprite rather than as something travelling.
 */
const BOLT_ART = [
  '................',
  '................',
  '.....o..........',
  '....oEo.........',
  '..ooEECo........',
  '.oEECCCCo.......',
  'oECCCCCCCo......',
  'oCCCCCCCCCo.....',
  'oCCCCCCCCCo.....',
  'oECCCCCCCo......',
  '.oEECCCCo.......',
  '..ooEECo........',
  '....oEo.........',
  '.....o..........',
  '................',
  '................',
];

/**
 * The **field glyph**: a ring laid on the ground under the target, for a status move that
 * affects rather than hits. Open in the middle so the creature inside it is still readable —
 * a filled disc under a sprite reads as a shadow bug.
 */
const FIELD_ART = [
  '.....oooooo.....',
  '...ooEEEEEEoo...',
  '..oEECCCCCCEEo..',
  '.oEECo....oCEEo.',
  '.oECo......oCEo.',
  'oEECo......oCEEo',
  'oECo........oCEo',
  'oECo........oCEo',
  'oECo........oCEo',
  'oEECo......oCEEo',
  '.oECo......oCEo.',
  '.oEECo....oCEEo.',
  '..oEECCCCCCEEo..',
  '...ooEEEEEEoo...',
  '.....oooooo.....',
  '................',
];

/** A three-pixel mote, for the particles every shape throws. */
const MOTE_ART = [
  '.Co.',
  'CCCo',
  '.Co.',
  '....',
];

/**
 * **Eighteen elemental looks, `C` core and `E` edge.**
 *
 * Chosen against the mainline's own colour language rather than invented, and checked against
 * this renderer's grade: `environment` holds bloom at a `bloomThreshold` of 0.72 at noon and
 * lifts it at night, so a core is bright enough to bloom and an edge is deliberately below it —
 * an effect whose *whole* silhouette blows past the threshold is a white blob at 21:00, which is
 * the trap `ball.js` recorded losing a round to.
 */
export const ELEMENT = Object.freeze({
  normal:   { C: '#f2ede0', E: '#a8a08c' },
  fire:     { C: '#ffd27a', E: '#e04d1a' },
  water:    { C: '#9fe0ff', E: '#2f6fd0' },
  electric: { C: '#fff29a', E: '#e8c62c' },
  grass:    { C: '#c4f58a', E: '#4a9a2c' },
  ice:      { C: '#d8fbff', E: '#4fb8d0' },
  fighting: { C: '#ffb08a', E: '#c03028' },
  poison:   { C: '#e0a8f0', E: '#8a2f9a' },
  ground:   { C: '#f0dCa0', E: '#a8813c' },
  flying:   { C: '#e4e0ff', E: '#8878d8' },
  psychic:  { C: '#ffb0d0', E: '#d0357a' },
  bug:      { C: '#dcf08a', E: '#7a9020' },
  rock:     { C: '#e8dcc0', E: '#8a7040' },
  ghost:    { C: '#c8b8f0', E: '#5a4a90' },
  dragon:   { C: '#c0b0ff', E: '#5030d0' },
  dark:     { C: '#b0a498', E: '#4a3c30' },
  steel:    { C: '#e4e4f0', E: '#8a8aa8' },
  fairy:    { C: '#ffd0e0', E: '#d06a90' },
});

/**
 * Which of the three shapes a move is drawn as.
 *
 * Read off the move record rather than from a list of names, so a move added to
 * `moves.json` tomorrow is covered tomorrow. A **status** move affects rather than hits, so it
 * gets the ground glyph; a **physical** move is contact, so the impact lands on the target with
 * no travel; anything else is thrown, so it travels.
 */
export function shapeOf(move) {
  if (!move) return 'contact';
  if (move.c === STATUS_CATEGORY) return 'field';
  return move.c === PHYSICAL_CATEGORY ? 'contact' : 'projectile';
}

/** The palette for a type, falling back to `normal` for anything unrecognised. */
export const elementOf = (type) => ELEMENT[String(type ?? '').toLowerCase()] ?? ELEMENT.normal;

const MOTES = 12;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Builds the three meshes and hands back the phase-driven API.
 *
 * One quad per shape plus one instanced mote field — four draw calls at most, and only while
 * something is playing. Textures are painted once per (shape, type) pair and cached, because
 * eighteen types times three shapes is fifty-four small canvases and repainting one per strike
 * would allocate through a fight.
 */
export function makeStrikeVfx(THREE, ctx, { pitch = 45 } = {}) {
  const scene = ctx.three.scene;
  // Sprites are 16 texels per world unit and their quads are stretched by `1/cos(pitch)`
  // (DECISIONS #18), so an effect drawn on the same grid sits in the same space as the
  // creatures it is between.
  const stretch = 1 / Math.cos((pitch * Math.PI) / 180);
  const cache = new Map();

  function texFor(art, type, key) {
    const id = `${key}/${type}`;
    let t = cache.get(id);
    if (!t) { t = texture(THREE, paint(art, { ...SHARED, ...elementOf(type) }, 16)); cache.set(id, t); }
    return t;
  }

  /**
   * `depthTest: false` on the billboards, and it is the difference between an effect and no
   * effect. A creature sprite is an alpha-tested quad that **writes depth**, and an impact
   * lands on the same cell — so at the same depth the sprite wins and the burst is drawn and
   * invisible. Measured: the impact mesh reporting `visible: true, opacity 0.53` with nothing on
   * screen. The ground glyph keeps its depth test, because a ring lying on the floor *should*
   * disappear behind a hill.
   */
  /**
   * **Built WITH its texture, never assigned one later.**
   *
   * A `MeshBasicMaterial` created with `map: null` compiles a shader with no `USE_MAP`, and
   * assigning `.map` afterwards leaves it drawing flat white until something forces a recompile
   * — which `needsUpdate` did not reliably do here. The symptom was an effect that was present,
   * visible, positioned, unculled and **a solid pale rectangle**: every diagnostic said it was
   * working and the frame said otherwise. Handing the map in at construction removes the
   * question, and swapping `map` between two textures of the same shape afterwards is a uniform
   * change rather than a shader change (DECISIONS #79).
   */
  const quad = (w, h, art, { test = false } = {}) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      map: texFor(art, 'normal', art === IMPACT_ART ? 'impact' : art === BOLT_ART ? 'bolt' : 'field'),
      transparent: true, depthWrite: false, depthTest: test, opacity: 1,
      // **`DoubleSide`, and it is not belt-and-braces.** A `PlaneGeometry` faces +Z, and this
      // camera looks north and down — so an un-rotated quad faces *away* and `FrontSide` draws
      // nothing at all. `ball.js` has carried `DoubleSide` since it was written for the same
      // reason. `alphaTest` keeps the pixel-art edge hard while `opacity` still fades the whole
      // effect out (DECISIONS #79).
      side: THREE.DoubleSide,
      alphaTest: 0.1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.renderOrder = 6;
    // Never culled. These are moved every sim step and their bounding spheres are computed
    // once, at the origin, from a geometry that never changes — so the cull test answers about
    // where the quad *was authored*, not where it is being drawn. The motes were visible and
    // the quads were not, which is the same bug seen from two sides.
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };

  const impact = quad(1.15, 1.15 * stretch, IMPACT_ART);
  const bolt = quad(1.1, 1.1 * stretch, BOLT_ART);
  // The field glyph lies on the ground, so it is the one thing here that is not a billboard.
  const field = quad(2.2, 2.2, FIELD_ART, { test: true });
  field.rotation.x = -Math.PI / 2;

  const moteGeo = new THREE.PlaneGeometry(0.26, 0.26 * stretch);
  const moteMat = new THREE.MeshBasicMaterial({
    map: texFor(MOTE_ART, 'normal', 'mote'),
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, alphaTest: 0.1,
  });
  const motes = new THREE.InstancedMesh(moteGeo, moteMat, MOTES);
  motes.visible = false;
  motes.renderOrder = 6;
  motes.frustumCulled = false;
  scene.add(motes);
  const m4 = new THREE.Matrix4();

  /** @type {{shape:string, type:string, from:object, to:object, steps:number}|null} */
  let live = null;
  const hideAll = () => {
    impact.visible = false; bolt.visible = false; field.visible = false; motes.visible = false;
  };

  return {
    /**
     * Stages one strike. `from` and `to` are world points — the attacker's feet and the
     * target's — and `steps` is how long the whole thing lasts, in sim steps.
     */
    play({ shape, type, from, to, steps = 10 }) {
      live = { shape, type, from, to, steps: Math.max(1, steps) };
      const t = elementOf(type);
      moteMat.map = texFor(MOTE_ART, type, 'mote');
      moteMat.color = new THREE.Color(t.C);
      moteMat.needsUpdate = true;
      impact.material.map = texFor(IMPACT_ART, type, 'impact');
      impact.material.needsUpdate = true;
      bolt.material.map = texFor(BOLT_ART, type, 'bolt');
      bolt.material.needsUpdate = true;
      field.material.map = texFor(FIELD_ART, type, 'field');
      field.material.needsUpdate = true;
      return true;
    },

    /**
     * Draws the strike at `p` in `[0, 1]`. Pure in the sense that matters: the same `p` gives
     * the same pixels, so a showcase can freeze on the impact and get it twice.
     */
    phase(p) {
      if (!live) { hideAll(); return; }
      const t = clamp01(p);
      hideAll();
      const { from, to, shape } = live;
      const lift = 1.05;

      if (shape === 'projectile') {
        // Two beats: it travels for the first two thirds, and lands for the last third.
        if (t < 0.66) {
          const k = t / 0.66;
          bolt.visible = true;
          bolt.position.set(lerp(from.x, to.x, k), lerp(from.y, to.y, k) + lift, lerp(from.z, to.z, k));
          // Pointed the way it is going. The art faces east, so this is the angle from the
          // travel vector in the XZ plane and nothing else — no roll, no pitch.
          bolt.rotation.z = -Math.atan2(to.z - from.z, to.x - from.x) * 0.35;
          bolt.material.opacity = 1;
          this.trail(from, to, k);
        } else {
          this.impactAt(to, (t - 0.66) / 0.34, lift);
        }
        return;
      }

      if (shape === 'contact') {
        // No travel: a contact move is already there. It lands hard and early, which is what
        // makes a physical hit read differently from a thrown one.
        this.impactAt(to, t, lift);
        return;
      }

      // field: the ring blooms out of the ground and the motes rise through it.
      field.visible = true;
      field.position.set(to.x, to.y + 0.06, to.z);
      const k = t < 0.5 ? t / 0.5 : 1;
      const s = 0.5 + 0.5 * k;
      field.scale.set(s, s, s);
      field.material.opacity = 1 - Math.max(0, (t - 0.6) / 0.4);
      this.rise(to, t);
    },

    /** The burst on the target, and the debris it throws. */
    impactAt(at, k, lift) {
      const t = clamp01(k);
      impact.visible = true;
      impact.position.set(at.x, at.y + lift, at.z);
      // Two discrete sizes rather than a ramp, for the reason `encounter/index.js` records
      // about the reveal: a fractional scale puts a sprite texel on a fraction of an internal
      // pixel, and the whole frame is built on that not happening (DECISIONS #60).
      const s = t < 0.3 ? 2 / 3 : 1;
      impact.scale.set(s, s, s);
      // A flash, not a lingering decal: full for the first third, then out.
      impact.material.opacity = t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5;
      this.burst(at, t, lift);
    },

    /** Motes flung out of the impact. */
    burst(at, t, lift) {
      motes.visible = true;
      for (let i = 0; i < MOTES; i++) {
        const a = (i / MOTES) * Math.PI * 2;
        const r = 0.15 + t * 0.95;
        m4.makeTranslation(at.x + Math.cos(a) * r, at.y + lift + Math.sin(a) * r * 0.6, at.z + Math.sin(a) * r * 0.5);
        motes.setMatrixAt(i, m4);
      }
      motes.instanceMatrix.needsUpdate = true;
      moteMat.opacity = 1 - t;
    },

    /** A short tail behind a travelling bolt. */
    trail(from, to, k) {
      motes.visible = true;
      for (let i = 0; i < MOTES; i++) {
        const back = clamp01(k - (i / MOTES) * 0.28);
        m4.makeTranslation(
          lerp(from.x, to.x, back), lerp(from.y, to.y, back) + 1.05, lerp(from.z, to.z, back),
        );
        motes.setMatrixAt(i, m4);
      }
      motes.instanceMatrix.needsUpdate = true;
      moteMat.opacity = 0.55;
    },

    /** Motes rising through a field glyph. */
    rise(at, t) {
      motes.visible = true;
      for (let i = 0; i < MOTES; i++) {
        const a = (i / MOTES) * Math.PI * 2;
        const h = ((t + i / MOTES) % 1) * 1.5;
        m4.makeTranslation(at.x + Math.cos(a) * 0.75, at.y + h, at.z + Math.sin(a) * 0.55);
        motes.setMatrixAt(i, m4);
      }
      motes.instanceMatrix.needsUpdate = true;
      moteMat.opacity = 1 - Math.max(0, (t - 0.6) / 0.4);
    },

    /** Everything off, and the record cleared. */
    hide() { live = null; hideAll(); },
    playing: () => !!live,

    /** Billboards follow the camera's yaw. Called from `frame`, like `ball.js`'s `refit`. */
    refit() {
      const cam = ctx.three.camera;
      if (!cam) return;
      for (const m of [impact, bolt, motes]) m.quaternion.copy(cam.quaternion);
    },

    dispose() {
      for (const m of [impact, bolt, field, motes]) {
        scene.remove(m);
        m.geometry?.dispose?.();
        m.material?.dispose?.();
      }
      for (const t of cache.values()) t.dispose?.();
      cache.clear();
    },
  };
}
