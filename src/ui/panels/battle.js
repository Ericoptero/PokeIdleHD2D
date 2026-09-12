/**
 * The battle readout — what just happened in the grass, in the corner of the screen.
 *
 * ## Why it is a card and not a window
 *
 * Every other panel here is `full: true`: a window over a dimmed scene, opened because the
 * player asked for it. A fight is neither. It is *started by the world* — the party walks up
 * to a slot and a battle begins (§5.6) — and in a hunt that happens every few seconds. A
 * full-screen window on that trigger would black out the loop the player is watching, dozens
 * of times a lap, uninvited.
 *
 * So this one is a docked card: no scrim, the HUD and the button strip stay up, and it sits
 * above the party bar on the left where the lead it is describing already is. It still goes
 * through `PANELS` and the panel slot, because the alternative is a second drawing layer with
 * its own lifetime — and it **never steals a panel the player opened** (`ui/index.js` checks
 * `panelOpen()` before auto-opening it).
 *
 * ## Why it reads a finished fight
 *
 * `encounter.begin()` resolves the whole battle synchronously and keeps the transcript
 * (§5.17: one implementation of what a turn is, looped by `resolve`). The scene that follows
 * — appear, throw, shake, capture — is the *animation* of an outcome that already exists. So
 * this card is a readout of that record and not a live scoreboard: both HP bars where they
 * ended, the turns it took, the last few lines of the transcript, and the pity meter that
 * decides what the ball about to be thrown is worth.
 *
 * That last part is the point of putting the meter here rather than in the shop. The pity sum
 * is per species (DECISIONS #68) and the only moment it matters is the moment a ball is about
 * to be thrown at that species.
 */

import { C, panel, well, meter, hpInk } from '../theme.js';
import { action } from './common.js';
import { titleCase, fmt } from '../format.js';
import { ellipsize } from '../font.js';

const isLive = (api) => !!api && api.__missing === undefined;

/** The card's own width. Clamped to the buffer, which is 426 px wide at 720p. */
const WIDTH = 176;

export const STATUS_NAME = {
  brn: 'BRN', psn: 'PSN', tox: 'TOX', par: 'PAR', slp: 'SLP', frz: 'FRZ',
};

/**
 * One transcript event as one line.
 *
 * Only the kinds a player would notice. `boost`, `drain` and `residual` are real and are
 * deliberately folded away: six lines of "Attack fell" push the move that decided the fight
 * off the top of a card eight rows tall, and the card is a summary, not a log. The full
 * transcript is on `encounter.transcript()` for anyone who wants all of it.
 */
export function lineFor(ev, names) {
  // **The event's own species wins over the side's name.** A duel swaps a fainted member out
  // mid-fight now (DECISIONS #72), so `names.a` is whoever is standing there *at paint time* —
  // and reading it for a move made three turns ago credited Oshawott's Tackle to the Snivy that
  // replaced it. Every event that uses `who` carries the actor in `species`; every event that
  // uses `foe` carries the victim in it. `names` stays as the fallback for a staged record that
  // has no species on its events.
  const who = titleCase(ev.species ?? '') || names[ev.actor] || '';
  const foe = titleCase(ev.species ?? '') || (ev.actor === 'a' ? names.b : names.a) || '';
  switch (ev.kind) {
    case 'move': return { text: `${who} used ${ev.name}`, ink: C.ink, move: true };
    case 'damage': {
      // The multiplier itself (2, 4, 0.5, 0.25), not a word for it: the card is eight rows
      // tall and "It's super effective!" is a whole row. `−` is U+2212 and `½` is not in the
      // font at all (`ui/selftest.js` checks exactly this), so both are ASCII here.
      const tag = ev.effectiveness !== 1 ? `  ×${ev.effectiveness}` : '';
      const crit = ev.crit ? '  crit' : '';
      return { text: `  -${ev.damage} HP${tag}${crit}`, ink: ev.effectiveness > 1 ? C.roofShadow : C.shadowInk };
    }
    case 'miss': return { text: `  ${foe} avoided it`, ink: C.stoneShadow };
    case 'immune': return { text: `  it doesn't affect ${foe}`, ink: C.stoneShadow };
    case 'status': return { text: `  ${titleCase(ev.species)} is ${STATUS_NAME[ev.status] ?? ev.status}`, ink: C.martShadow };
    case 'confused': return { text: `  ${titleCase(ev.species)} is confused`, ink: C.martShadow };
    case 'confused-hit': return { text: `${who} hurt itself -${ev.damage}`, ink: C.roofShadow };
    case 'flinch': return { text: `${who} flinched`, ink: C.stoneShadow };
    case 'asleep': return { text: `${who} is fast asleep`, ink: C.stoneShadow };
    case 'frozen': return { text: `${who} is frozen solid`, ink: C.stoneShadow };
    case 'paralysed': return { text: `${who} is paralysed`, ink: C.stoneShadow };
    case 'recoil': return { text: `  recoil -${ev.damage}`, ink: C.shadowInk };
    case 'faint': return { text: `${titleCase(ev.species)} fainted`, ink: C.roofBase };
    default: return null;
  }
}

export function makeBattle(app) {
  /** A staged record, when a showcase injects one. Null means "read the live encounter". */
  let staged = null;

  const get = (id) => app.ctx.get(id);

  /**
   * The card's whole model, gathered through published APIs at paint time — the same
   * discipline `hud.read()` follows, and the reason a quarantined `economy` costs this card
   * its pity meter rather than costing it its HP bars.
   */
  function read() {
    if (staged) return staged;
    const enc = get('encounter');
    const active = isLive(enc) && typeof enc.active === 'function' ? enc.active() : null;
    if (!active?.battle) return null;

    const pk = get('pokemon');
    const bt = get('battle');
    const lead = isLive(pk) && typeof pk.lead === 'function' ? pk.lead() : null;

    // The wild's maximum HP is not in the encounter record — only the fraction it ended on
    // is, because that is all `catchOdds` needs. It is recomputed from the same published
    // function the engine itself used, so the bar and the fight agree by construction.
    let wildMax = 0;
    if (isLive(bt) && typeof bt.stats === 'function' && active.sheet?.baseStats) {
      wildMax = bt.stats(active.sheet.baseStats, active.ivs ?? {}, active.level).hp;
    }
    /**
     * **The card reads the live fight, not the party record.**
     *
     * A duel is stepped one turn at a time now (DECISIONS #72), and the HP and PP it costs are
     * written back through `pokemon` only when the last blow lands — so reading `pokemon.lead()`
     * mid-fight draws two full bars under a transcript that says somebody fainted. The stepper's
     * own state is the authority while the fight is running, and it also knows which member is
     * *currently* out, which the party's lead does not until the encounter resolves.
     */
    const st = active.duel?.engine ? active.duel.run?.state : null;
    const fighting = active.battle.win === null;
    const side = st?.a ?? null;

    const frac = st
      ? (st.b.maxHp > 0 ? st.b.hp / st.b.maxHp : 1)
      : Math.max(0, Math.min(1, Number(active.hpFraction) || 0));

    return {
      // `null` while the duel is being stepped, and every reader has to tell that from `false`:
      // a fight in progress is not a fight that was lost.
      won: active.battle.win === null ? null : !!active.battle.win,
      fighting,
      turns: active.battle.turns ?? 0,
      transcript: active.battle.transcript ?? [],
      ally: side ? {
        display: titleCase(side.display ?? side.species),
        level: side.level ?? 1,
        shiny: !!side.shiny,
        hp: Math.max(0, side.hp ?? 0),
        maxHp: Math.max(1, side.maxHp ?? 1),
        status: side.status ?? null,
        moves: side.moves ?? [],
      } : (lead ? {
        display: app.hud.displayName(lead.species),
        level: lead.level ?? 1,
        shiny: !!lead.shiny,
        hp: Math.max(0, lead.hp ?? 0),
        maxHp: Math.max(1, lead.maxHp ?? 1),
        status: lead.status ?? null,
        moves: lead.moves ?? [],
      } : null),
      wild: {
        species: active.species,
        display: titleCase(active.display ?? active.species),
        level: active.level ?? 1,
        shiny: !!active.shiny,
        types: active.sheet?.types ?? [],
        hp: st ? Math.max(0, st.b.hp) : Math.round(wildMax * frac),
        maxHp: st ? Math.max(1, st.b.maxHp) : wildMax,
        frac,
        status: st?.b?.status ?? null,
      },
      ball: typeof enc.ball === 'function' ? enc.ball() : null,
      odds: typeof enc.oddsFor === 'function' ? enc.oddsFor(enc.ball?.()) : 0,
      live: true,
    };
  }

  /**
   * The throw, and the run.
   *
   * **This is what closes the oldest open core request on this module**: `encounter.attempt`
   * has existed since DECISIONS #35 and until now nothing in the game called it — `automation`
   * is off by default (§5.11) and there was no input path, so a player at the keyboard could
   * not catch anything by hand. `attempt()` queues the throw on the scene's own timeline; the
   * card stays up and `encounter:resolved` takes it down.
   */
  function throwBall() {
    const enc = get('encounter');
    if (!isLive(enc) || typeof enc.attempt !== 'function') return;
    const id = typeof enc.ball === 'function' ? enc.ball() : undefined;
    enc.attempt(ballsLeft(id) > 0 ? id : (bestBall() ?? id));
    app.markDirty();
  }

  /** `economy`'s pick among the balls actually in the bag, when the selected one has run out. */
  function bestBall() {
    const enc = get('encounter');
    if (!isLive(enc) || typeof enc.bestBall !== 'function') return null;
    return enc.bestBall()?.id ?? null;
  }

  function run() {
    const enc = get('encounter');
    if (!isLive(enc) || typeof enc.flee !== 'function') return;
    enc.flee();
    app.markDirty();
  }

  /** How many of the selected ball are in the bag. Zero greys the button rather than hiding it. */
  function ballsLeft(id) {
    const eco = get('economy');
    if (!isLive(eco) || typeof eco.count !== 'function' || !id) return 0;
    return Number(eco.count(id)) || 0;
  }

  const ballName = (id) => {
    const eco = get('economy');
    const def = isLive(eco) && typeof eco.item === 'function' ? eco.item(id) : null;
    return def?.name ?? 'Ball';
  };

  /** The pity ledger for the species being fought, or null when `economy` is not there. */
  function pityOf(species) {
    const eco = get('economy');
    if (!isLive(eco) || typeof eco.pity !== 'function' || !species) return null;
    const m = eco.pity(species);
    return Number.isFinite(m?.price) ? m : null;
  }

  return {
    id: 'battle',
    /** A card, not a window: the scene behind it stays lit and the HUD stays up. */
    full: false,

    open(opts) { staged = opts?.fight ?? null; },
    close() { staged = null; },

    /**
     * Z throws, R runs. The card owns the keyboard while it is up (`ui/input.js` gives an open
     * panel every key), and these are the only two decisions a fight leaves the player.
     */
    key(ev) {
      const b = read();
      if (!b?.won || !b.live) return false;
      if (ev.code === 'Enter' || ev.code === 'KeyZ' || ev.code === 'Space') { throwBall(); return true; }
      if (ev.code === 'KeyR') { run(); return true; }
      return false;
    },

    /** Whether there is anything to draw. `ui` asks before it auto-opens. */
    has: () => !!read(),

    draw(g) {
      const b = read();
      if (!b) return;

      const w = Math.min(WIDTH, g.width - 8);
      const rows = [];
      for (const ev of b.transcript) {
        const line = lineFor(ev, { a: b.ally?.display ?? 'Your Pokémon', b: b.wild.display });
        if (line) rows.push(line);
      }
      // The END of the fight, not the beginning: the last lines are the ones that decided
      // it, and a card that showed the first four would caption every battle with its opening
      // move. The window is then pulled back to the nearest "X used Y", because a damage line
      // with no move above it is a number with nothing to attach to.
      let cut = Math.max(0, rows.length - 4);
      while (cut > 0 && !rows[cut].move) cut--;
      const shown = rows.slice(cut).slice(-5);
      const pity = pityOf(b.wild.species);

      // Measured, not estimated. Every row this card can draw is optional — the types, both
      // status lines, the transcript, the meter — so a constant would leave a band of empty
      // paper under a short fight and clip a long one.
      const ROW = 9;
      const blockH = (who, extra) => 17 + (who?.status ? ROW : 0) + extra;
      const buttons = b.won === true;
      const h = 8                                        // the panel's own padding
        + blockH(b.wild, b.wild.types.length ? ROW : 0)
        + 2 + (b.ally ? blockH(b.ally, 0) : 0)
        + 13                                             // the rule and the verdict
        + (shown.length ? shown.length * 8 + 5 : 0)
        + (pity ? 23 : 0)
        + (buttons ? 26 : 0);

      // Above the party bar, on the left, where the lead this card is describing already is.
      // `app.partyBox()` is where the bar actually landed this frame — it moves up when the
      // touch pad is out, and a card measured against a constant would sit on top of it.
      const party = app.partyBox();
      const bottom = (party ? party.y : g.height - 4) - 4;
      const box = { x: 4, y: Math.max(22, bottom - h), w, h: Math.min(h, bottom - 22) };

      panel(g, box, { paper: C.wallBase });
      let y = box.y + 4;
      const x = box.x + 5;
      const right = box.x + box.w - 5;
      const barW = box.w - 10;

      // --- the two combatants ------------------------------------------------
      function side(who, wild) {
        // "WILD" in front of the foe's name, the way the games caption it. Without it the
        // card is two names in a stack and nothing says which one is yours.
        let nx = x;
        if (wild) {
          // Ink, not a plate. A four-letter chip at this size is 19 px of glyph inside a 21 px
          // box and it read as a smudge; the word in the accent colour reads at every scale.
          g.text(x, y, 'WILD', C.roofShadow);
          nx = x + g.measure('WILD') + 4;
        }
        const label = ellipsize(who.display, right - nx - 26);
        g.text(nx, y, label, C.ink);
        if (who.shiny) g.text(nx + g.measure(label) + 2, y, '★', C.glowDeep);
        g.textRight(right, y, `Lv ${who.level}`, C.shadowInk);
        y += 9;
        const frac = who.maxHp > 0 ? who.hp / who.maxHp : 0;
        meter(g, { x, y, w: barW - 30, h: 5 }, frac, { ...hpInk(frac), back: C.wallDeep });
        g.textRight(right, y - 1, `${who.hp}/${who.maxHp}`, frac <= 0.2 ? C.roofShadow : C.shadowInk);
        y += 8;
        if (who.status) {
          // Ink for the same reason `WILD` is ink: three letters reversed out of a 16 px
          // plate came out as a smudge in the capture, and the plate bought nothing.
          g.text(x, y, STATUS_NAME[who.status] ?? '???', C.roofShadow);
          y += 9;
        }
      }

      // The wild on top and yours underneath — the mainline arrangement, and here it also
      // puts your Pokemon's bar directly above the party bar that names it.
      side(b.wild, true);
      if (b.wild.types.length) {
        g.text(x, y, b.wild.types.join(' / '), C.stoneShadow, { max: barW });
        y += 9;
      }
      y += 2;
      if (b.ally) side(b.ally, false);

      // --- the verdict --------------------------------------------------------
      g.fill(x, y, barW, 1, C.wallDeep);
      y += 3;
      // **Three verdicts, not two.** A duel is stepped now, so `won` is `null` until somebody
      // faints — and rendering that as "Lost after 3" put a defeat on screen in the middle of a
      // fight the party went on to win (DECISIONS #72).
      g.text(x, y,
        b.won === null ? `Turn ${Math.max(1, b.turns)}`
          : b.won ? `Won in ${b.turns} turn${b.turns === 1 ? '' : 's'}` : `Lost after ${b.turns}`,
        b.won === null ? C.glowBase : b.won ? C.ink : C.roofBase);
      y += 10;

      // --- the last few lines of the transcript -------------------------------
      if (shown.length) {
        const tray = { x: box.x + 3, y, w: box.w - 6, h: shown.length * 8 + 2 };
        if (tray.y + tray.h <= box.y + box.h - 2) {
          well(g, tray, {});
          let ty = tray.y + 1;
          for (const line of shown) {
            g.text(tray.x + 2, ty, ellipsize(line.text, tray.w - 4), line.ink);
            ty += 8;
          }
          y = tray.y + tray.h + 3;
        }
      }

      // --- the pity meter -----------------------------------------------------
      //
      // The one number in this game a player cannot derive: how much they have already spent
      // chasing this species, against what it is worth. Below 90 % the bar is simply the
      // spend; from 90 % it is the floor under the next throw, and the caption says which.
      if (pity && y + 18 <= box.y + box.h) {
        const shown90 = Math.min(1, pity.ratio / 1.25);
        g.text(x, y, 'PITY', C.shadowInk);
        g.textRight(right, y, pity.t > 0 ? `+${Math.round(pity.t * 100)}%` : `${Math.round(pity.ratio * 100)}%`,
          pity.t > 0 ? C.glowDeep : C.shadowInk);
        y += 8;
        meter(g, { x, y, w: barW, h: 5 }, shown90,
          { fill: pity.t > 0 ? C.glowBase : C.stoneBase, light: pity.t > 0 ? C.glowLight : C.stoneLight, back: C.wallDeep });
        // The 90 % mark, drawn ON the bar: it is the moment the rule changes, and a meter
        // whose behaviour changes at an invisible point is a meter nobody can read.
        const tick = x + 1 + Math.round((barW - 2) * (0.90 / 1.25));
        g.fill(tick, y, 1, 5, C.roofShadow);
        y += 7;
        g.text(x, y, `₽${fmt(Math.round(pity.sum))} / ₽${fmt(pity.price)}`, C.stoneShadow, { max: barW - 40 });
        // The odds only on a win. `attempt()` refuses to throw at a fight that was lost
        // (DECISIONS #67), so a catch percentage under "Lost after 1" is a number for a throw
        // the game will not accept. The meter itself stays: what has been spent on this
        // species is true either way.
        if (b.won === true && b.odds > 0) g.textRight(right, y, `${Math.round(b.odds * 100)}%`, C.ink);
        y += 9;
      }

      // --- the two decisions a won fight leaves ------------------------------
      //
      // The throw is the whole reason this card exists: `encounter.attempt` has been published
      // since DECISIONS #35 and nothing in the game ever called it. `automation` can still do
      // it for you, and it is off by default, so without these buttons a player at the keyboard
      // watches every Pokemon they beat walk away.
      if (buttons && y + 13 <= box.y + box.h) {
        // The selected ball, or the best one still in the bag. Without the fallback a bag with
        // no Poké Balls and twelve Great Balls reads NO BALLS and the throw is unreachable.
        const id = ballsLeft(b.ball) > 0 ? b.ball : (bestBall() ?? b.ball);
        const left = ballsLeft(id);
        const half = Math.floor((barW - 3) * 0.66);
        action(g, { x, y, w: half, h: 13 },
          left > 0 ? `THROW ${left}` : 'NO BALLS', {
            disabled: !b.live || left <= 0, active: b.live && left > 0,
            onPick: throwBall, tag: 'battle-throw',
          });
        action(g, { x: x + half + 3, y, w: barW - half - 3, h: 13 }, 'RUN', {
          disabled: !b.live, onPick: run, tag: 'battle-run',
        });
        // The ball's own name, under the button that spends it — "THROW 26" says how many, not
        // of what, and the bag holds five kinds by the time this matters.
        if (id && y + 22 <= box.y + box.h) {
          g.text(x, y + 15, `Z ${ballName(id)}    R run`, C.stoneShadow, { max: barW });
        }
      }
      // Handed back so `ui` can keep a plate from drawing on top of the card — the same
      // discipline as `partyBox`/`stripBox` (`ui/index.js`).
      return box;
    },
  };
}
