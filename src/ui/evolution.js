/**
 * The evolution cutscene — a full-resolution DOM overlay, not a sprite swap.
 *
 * DECISIONS #63 animated the evolution on the **overworld sprite**, and the player could not
 * see it: the button that starts it lives in the party panel, the party panel is full-screen,
 * and the flash was happening on a 32-pixel sprite behind it. It was a correct animation in a
 * place nobody was looking.
 *
 * So the moment is a cutscene now, and it is DOM and CSS rather than WebGL for one concrete
 * reason: **the sprite mesh has no per-instance colour** (`pokemon/field.js` patches a
 * `aUvRect` attribute and nothing else), so the white silhouette that *is* the mainline's
 * evolution animation is impossible there. It is one CSS filter here —
 * `brightness(0) invert(1)` — and so are the glow, the rays and the burst.
 *
 * ## It stays reproducible
 *
 * `?showcase=…` promises the same URL gives the same pixels (§6.3), and a five-second
 * animation caught ninety settle-frames after `__READY__` would give a different one every
 * run. Every animated element here is driven by one clock, so `freeze(t)` holds the whole
 * cutscene at an exact moment with `animation-delay: -t` and `animation-play-state: paused` —
 * the browser's own timeline, sampled, rather than a second implementation of it.
 *
 * ## The swap keyframes are generated, not hand-written
 *
 * The accelerating alternation comes from `pokemon`'s own `frameAt`/`swapsBy` timing — the
 * same pure functions the overworld animation used and the same ones its checks pin. A
 * hand-written `@keyframes` block would be a second copy of the timing that could drift from
 * the first, which is the failure mode `tools/seams/run.js` rule 5 exists for.
 */

/** Beats, in seconds. The whole thing is `TOTAL` long and every keyframe is a fraction of it. */
export const BEATS = {
  dim: 0.45,        // the world darkens and the old form fades up
  flashIn: 0.35,    // it goes white and the rays start
  alternate: 2.40,  // old / new, accelerating
  burst: 0.55,      // the white-out
  reveal: 0.90,     // the new form in colour, with a shine
  hold: 1.10,       // "… evolved into …"
};
export const TOTAL = Object.values(BEATS).reduce((a, b) => a + b, 0);

/** Where each beat starts, so the generated keyframes and the CSS agree on one clock. */
const T = (() => {
  let t = 0;
  const out = {};
  for (const [k, d] of Object.entries(BEATS)) { out[k] = t; t += d; }
  out.end = t;
  return out;
})();

const pct = (t) => `${((t / TOTAL) * 100).toFixed(3)}%`;

/**
 * Turns the alternation's swap times into two opacity tracks.
 *
 * The blink is a real gap where **neither** layer is shown — it is what stops the alternation
 * reading as a dropped frame, and it is the reason this is two tracks rather than one
 * crossfade.
 */
export function swapKeyframes(swapsBy, alternateS) {
  const times = [];
  let t = 0;
  for (let i = 0; i < 256 && t < alternateS; i++) {
    const { step } = swapsBy(t);
    times.push(t);
    t += step;
  }
  const BLINK = 0.035;
  const old = [];
  const neu = [];
  const at = (arr, time, v) => arr.push(`${pct(T.flashIn + Math.min(time, alternateS))}{opacity:${v}}`);

  for (let i = 0; i < times.length; i++) {
    const showNew = i % 2 === 1;
    at(old, times[i], 0);
    at(neu, times[i], 0);
    at(old, times[i] + BLINK, showNew ? 0 : 1);
    at(neu, times[i] + BLINK, showNew ? 1 : 0);
  }
  return {
    old: `0%{opacity:1}${pct(T.flashIn)}{opacity:1}${old.join('')}${pct(T.burst)}{opacity:0}100%{opacity:0}`,
    neu: `0%{opacity:0}${pct(T.flashIn)}{opacity:0}${neu.join('')}${pct(T.burst)}{opacity:1}100%{opacity:1}`,
  };
}

/**
 * One sprite frame, cropped out of a walk sheet with `background-position`.
 *
 * Rows are `[north, west, south, east]` (ARCHITECTURE §5.5, measured from the shipped art), so
 * row 2 is the front-facing one — the only one worth looking at for four seconds. Column 0 is
 * the contact frame of the two-frame walk cycle.
 */
function makeSprite(cls, url, frame, scale) {
  const el = document.createElement('div');
  el.className = `evo-sprite ${cls}`;
  const size = frame * scale;
  // Set as PROPERTIES, never as an HTML attribute. The first cut interpolated this into
  // `style="…"` inside a template literal and the `url("…")` quotes closed the attribute at
  // the first inner `"` — so width and height applied, everything after them was thrown away,
  // and the element rendered as a 338px square of nothing. `background-image` came back as
  // `url("")` in the computed style, which is what gave it away.
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.backgroundImage = `url(${JSON.stringify(url)})`;
  el.style.backgroundSize = `${size * 2}px ${size * 4}px`;
  // Rows are [north, west, south, east] (§5.5), so row 2 is front-facing; column 0 is the
  // contact frame of the two-frame walk cycle.
  el.style.backgroundPosition = `0px ${-size * 2}px`;
  el.style.backgroundRepeat = 'no-repeat';
  el.style.imageRendering = 'pixelated';
  return el;
}

export function makeEvolutionOverlay(app) {
  let node = null;
  let styleEl = null;
  let timer = 0;

  const teardown = () => {
    clearTimeout(timer);
    node?.remove();
    styleEl?.remove();
    node = null;
    styleEl = null;
  };

  /**
   * Builds the whole cutscene as one DOM tree plus one stylesheet.
   *
   * @param {{from:object, to:object, shiny?:boolean, freezeAt?:number}} spec
   */
  function build({ from, to, shiny = false, freezeAt = null }) {
    const pk = app.ctx.get('pokemon');
    const live = (a) => !!a && a.__missing === undefined;
    if (!live(pk) || typeof pk.spriteUrl !== 'function') return null;

    const oldUrl = pk.spriteUrl(from, { shiny });
    const newUrl = pk.spriteUrl(to, { shiny });
    // The two sheets can be different sizes — 61 of the 1253 are 64-pixel giants — so each
    // sprite is cropped against its own frame and the bigger of the two sets the stage.
    const oldFrame = from?.sheet?.frame ?? 32;
    const newFrame = to?.sheet?.frame ?? 32;
    const scale = Math.max(3, Math.round((Math.min(window.innerHeight, 900) * 0.34) / Math.max(oldFrame, newFrame)));

    const anim = pk.evolutionTiming?.() ?? null;
    const tracks = anim
      ? swapKeyframes(anim.swapsBy, Math.min(anim.ALTERNATE_S, BEATS.alternate))
      : { old: '0%{opacity:1}100%{opacity:0}', neu: '0%{opacity:0}100%{opacity:1}' };

    styleEl = document.createElement('style');
    styleEl.id = 'evo-style';
    styleEl.textContent = CSS(tracks);
    document.head.appendChild(styleEl);

    node = document.createElement('div');
    node.id = 'evo-overlay';
    node.style.setProperty('--dur', `${TOTAL}s`);

    const div = (cls) => { const e = document.createElement('div'); e.className = cls; return e; };
    node.append(div('evo-veil'), div('evo-rays'), div('evo-rays evo-rays-b'));

    const stage = div('evo-stage');
    stage.append(div('evo-glow'), makeSprite('evo-old', oldUrl, oldFrame, scale),
      makeSprite('evo-new', newUrl, newFrame, scale));
    node.append(stage, div('evo-burst'));

    for (let i = 0; i < 14; i++) {
      // Fixed angles and delays, never random: `Math.random()` is banned in `src/` (§2.5), and
      // a sparkle ring that moved between two captures of one URL would break §6.3 anyway.
      const a = (i / 14) * Math.PI * 2;
      const spark = document.createElement('i');
      spark.className = 'evo-spark';
      spark.style.setProperty('--dx', `${(Math.cos(a) * 260).toFixed(1)}px`);
      spark.style.setProperty('--dy', `${(Math.sin(a) * 260).toFixed(1)}px`);
      spark.style.setProperty('--i', String(i));
      node.append(spark);
    }

    const line = document.createElement('p');
    line.className = 'evo-line';
    const name = (sp) => {
      const el = document.createElement('span');
      el.textContent = String(sp?.display ?? sp?.name ?? '').toUpperCase();
      return el;
    };
    line.append(name(from), document.createTextNode(' evolved into '), name(to),
      document.createTextNode('!'));
    node.append(line);

    (document.getElementById('ui') ?? document.body).appendChild(node);

    if (freezeAt != null) {
      // The browser's own timeline, sampled. A negative delay starts an animation part-way in
      // and `paused` holds it there, so a capture is the real cutscene at that instant rather
      // than a second drawing of it.
      node.classList.add('evo-frozen');
      node.style.setProperty('--at', `${-freezeAt}s`);
    }
    return node;
  }

  return {
    /** Plays it, and resolves when the overlay is gone. */
    play(spec) {
      teardown();
      if (!build(spec)) return Promise.resolve(false);
      return new Promise((done) => {
        timer = setTimeout(() => { teardown(); done(true); }, TOTAL * 1000 + 120);
      });
    },
    /** Holds it at `t` seconds and leaves it on screen. For `?showcase=` captures only. */
    freeze(spec, t) {
      teardown();
      return !!build({ ...spec, freezeAt: t });
    },
    close: teardown,
    TOTAL,
    BEATS,
  };
}

const CSS = (tracks) => `
/* ONE GRID CELL, EVERYTHING STACKED IN IT. The first cut positioned each layer absolutely
   with no offsets, so every one of them took its static position: the rays rendered as a
   4993px square hanging off the bottom-left corner and the sprites sat wherever the collapsed
   stage put them. Stacking on grid-area 1/1 centres every layer without a single
   translate(-50%,-50%), which matters because the animations own the transform. */
#evo-overlay{position:absolute;inset:0;overflow:hidden;pointer-events:none;
  display:grid;grid-template:100% / 100%;z-index:40;--at:0s;isolation:isolate}
/* The track is pinned to the overlay and every layer is centred INSIDE it with place-self.
   An auto track is sized by its largest item, and the ray fan is 190vmax — so the single cell
   came out 3648px wide, everything centred against THAT, and the whole cutscene sat at
   (1573,1573) with only the veil's corner on screen. Measured, not guessed: the veil reported
   3648x3648 for a width of 100%. */
#evo-overlay > *{grid-area:1/1;place-self:center}
#evo-overlay.evo-frozen *{animation-delay:var(--at)!important;animation-play-state:paused!important}
#evo-overlay.evo-frozen .evo-spark{animation-delay:calc(var(--at) + var(--i) * 0.012s)!important}

.evo-veil{width:100%;height:100%;
  background:radial-gradient(circle at 50% 46%, rgba(12,16,28,.72) 0%, rgba(4,6,12,.96) 62%);
  opacity:0;animation:evo-veil var(--dur) linear forwards}
@keyframes evo-veil{
  0%{opacity:0}${pct(T.flashIn)}{opacity:1}
  ${pct(T.hold + BEATS.hold * 0.55)}{opacity:1}100%{opacity:0}}

/* Two counter-rotating fans of light. A conic gradient with hard stops is a starburst, and
   it costs one element instead of forty. */
.evo-rays{width:120vmax;height:120vmax;border-radius:50%;
  background:conic-gradient(from 0deg,
    rgba(255,247,220,.55) 0deg 6deg, transparent 6deg 22deg,
    rgba(255,247,220,.34) 22deg 27deg, transparent 27deg 45deg);
  mask-image:radial-gradient(circle, transparent 4%, #000 16%, rgba(0,0,0,.5) 40%, transparent 72%);
  -webkit-mask-image:radial-gradient(circle, transparent 4%, #000 16%, rgba(0,0,0,.5) 40%, transparent 72%);
  opacity:0;animation:evo-rays var(--dur) linear forwards}
.evo-rays-b{animation-name:evo-rays-b;width:104vmax;height:104vmax;
  background:conic-gradient(from 14deg,
    rgba(198,232,255,.42) 0deg 4deg, transparent 4deg 17deg,
    rgba(198,232,255,.26) 17deg 20deg, transparent 20deg 33deg)}
@keyframes evo-rays{
  0%{opacity:0;transform:rotate(0deg) scale(.5)}
  ${pct(T.flashIn)}{opacity:0}
  ${pct(T.alternate)}{opacity:.55;transform:rotate(60deg) scale(.85)}
  ${pct(T.burst)}{opacity:1;transform:rotate(200deg) scale(1.1)}
  ${pct(T.reveal)}{opacity:.35;transform:rotate(240deg) scale(1.2)}
  100%{opacity:0;transform:rotate(300deg) scale(1.3)}}
@keyframes evo-rays-b{
  0%{opacity:0;transform:rotate(0deg) scale(.6)}
  ${pct(T.flashIn)}{opacity:0}
  ${pct(T.alternate)}{opacity:.4;transform:rotate(-70deg) scale(.9)}
  ${pct(T.burst)}{opacity:.8;transform:rotate(-220deg) scale(1.15)}
  100%{opacity:0;transform:rotate(-300deg) scale(1.35)}}

.evo-stage{display:grid;place-items:center;
  animation:evo-stage var(--dur) cubic-bezier(.2,.9,.25,1) forwards}
.evo-stage > *{grid-area:1/1}
@keyframes evo-stage{
  0%{transform:scale(.72);opacity:0}
  ${pct(T.flashIn)}{transform:scale(1);opacity:1}
  ${pct(T.burst)}{transform:scale(1.06)}
  ${pct(T.burst + BEATS.burst * .55)}{transform:scale(1.34)}
  ${pct(T.reveal)}{transform:scale(1)}
  ${pct(T.hold + BEATS.hold * .6)}{transform:scale(1);opacity:1}
  100%{transform:scale(1.04);opacity:0}}

.evo-glow{width:44vmin;height:44vmin;border-radius:50%;
  background:radial-gradient(circle, rgba(255,252,232,.95) 0%, rgba(255,236,170,.45) 32%, transparent 68%);
  opacity:0;animation:evo-glow var(--dur) ease-out forwards}
/* HELD DIM UNTIL THE BURST, then spiked. Every T.x here is the START of beat x, and the
   first cut ramped from T.alternate straight to T.burst — which is the whole 2.4-second
   alternation spent fading a 475px white disc up to 0.67 behind a 337px sprite. The
   silhouette, the one thing the player is meant to be reading, came out as a featureless
   blob. Measured off the running page, not guessed. */
@keyframes evo-glow{
  0%{opacity:0;transform:scale(.35)}
  ${pct(T.alternate)}{opacity:.10;transform:scale(.66)}
  ${pct(T.burst)}{opacity:.20;transform:scale(.80)}
  ${pct(T.burst + BEATS.burst * .35)}{opacity:.85;transform:scale(1.45)}
  ${pct(T.reveal)}{opacity:.16;transform:scale(1)}
  100%{opacity:0}}

.evo-sprite{
  filter:brightness(0) invert(1) drop-shadow(0 0 14px rgba(255,244,206,.9));
  animation:evo-tint var(--dur) linear forwards}
/* THE WHITE-OUT IS SAVED FOR THE BURST, and the alternation keeps the art.
   The first cut held brightness(0) invert(1) — a true white silhouette, the mainline's own
   idea and the thing the WebGL sprite mesh cannot draw — for the whole alternation. Measured
   on the running page it was doing exactly what it was asked to, and it looked like a white
   blob: an overworld sprite is 32 texels, and a 32-texel shape flooded to one colour has no
   readable form at all. So the two forms stay in their own colours, lit and warm, while they
   cut between each other (which is the part the player is meant to READ — this Pokemon
   becoming that one), and the silhouette arrives as the flash into the burst. */
@keyframes evo-tint{
  0%{filter:brightness(1) saturate(1) drop-shadow(0 0 0 transparent)}
  ${pct(T.flashIn)}{filter:brightness(1.18) saturate(1.15) drop-shadow(0 0 10px rgba(255,238,180,.55))}
  ${pct(T.alternate + BEATS.alternate * .72)}{filter:brightness(1.3) saturate(1.1) drop-shadow(0 0 16px rgba(255,242,196,.75))}
  ${pct(T.burst)}{filter:brightness(0) invert(1) drop-shadow(0 0 26px rgba(255,252,232,1))}
  ${pct(T.burst + BEATS.burst * .35)}{filter:brightness(0) invert(1) drop-shadow(0 0 46px rgba(255,252,232,1))}
  ${pct(T.reveal)}{filter:brightness(1) saturate(1) drop-shadow(0 6px 12px rgba(0,0,0,.6))}
  100%{filter:brightness(1) saturate(1) drop-shadow(0 6px 12px rgba(0,0,0,.6))}}
.evo-old{animation:evo-tint var(--dur) linear forwards, evo-old var(--dur) steps(1,end) forwards}
.evo-new{animation:evo-tint var(--dur) linear forwards, evo-new var(--dur) steps(1,end) forwards}
@keyframes evo-old{${tracks.old}}
@keyframes evo-new{${tracks.neu}}

.evo-burst{width:100%;height:100%;background:#fffdf4;opacity:0;
  animation:evo-burst var(--dur) ease-out forwards}
@keyframes evo-burst{
  0%{opacity:0}${pct(T.burst)}{opacity:0}
  ${pct(T.burst + BEATS.burst * .35)}{opacity:.92}
  ${pct(T.reveal)}{opacity:0}100%{opacity:0}}

.evo-spark{width:9px;height:9px;border-radius:50%;
  background:radial-gradient(circle,#fffdf0 0%,#ffe9a8 45%,transparent 70%);
  opacity:0;animation:evo-spark var(--dur) ease-out forwards;
  animation-delay:calc(var(--i) * 0.012s)}
@keyframes evo-spark{
  0%{opacity:0;transform:translate(0,0) scale(.2)}
  ${pct(T.burst)}{opacity:0;transform:translate(0,0) scale(.2)}
  ${pct(T.burst + BEATS.burst * .3)}{opacity:1;transform:translate(calc(var(--dx) * .25), calc(var(--dy) * .25)) scale(1.5)}
  ${pct(T.reveal + BEATS.reveal * .7)}{opacity:0;transform:translate(var(--dx), var(--dy)) scale(.4)}
  100%{opacity:0}}

.evo-line{place-self:end center;margin:0 0 11vh;text-align:center;max-width:80vw;
  font:700 clamp(15px,2.2vmin,26px)/1.5 ui-monospace,"SF Mono",Menlo,monospace;
  letter-spacing:.10em;color:#f3ecda;text-transform:uppercase;
  text-shadow:0 2px 0 rgba(0,0,0,.7), 0 0 22px rgba(255,236,170,.5);
  opacity:0;animation:evo-line var(--dur) cubic-bezier(.2,.9,.25,1) forwards}
.evo-line span{color:#ffe487}
@keyframes evo-line{
  0%{opacity:0;transform:translateY(16px)}
  ${pct(T.hold)}{opacity:0;transform:translateY(16px)}
  ${pct(T.hold + BEATS.hold * .28)}{opacity:1;transform:translateY(0)}
  ${pct(T.hold + BEATS.hold * .78)}{opacity:1;transform:translateY(0)}
  100%{opacity:0;transform:translateY(-8px)}}

@media (prefers-reduced-motion: reduce){
  #evo-overlay *{animation-duration:.01ms!important;animation-iteration-count:1!important}
  .evo-line{opacity:1!important;animation:none!important}
}
`;
