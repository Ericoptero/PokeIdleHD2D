/**
 * Hollow Deep — enclosed, floored and walled in rock, with the light at the mouth.
 *
 * References are `docs/refs/02-cave-tilemap.png` and `04-cave-golden-hour.png`: terraced
 * rock, no sky anywhere, a floor that reads as stone rather than as ground, and depth built
 * out of *levels* — the golden-hour still is almost entirely one bank of rock stepping up
 * behind another.
 *
 * `bw2-cave` is the tileset (53 cave models), so this is the one hunt that does not draw on
 * AdAstra at all. Its structure, measured off the pack:
 *
 *  - `set0 cave_rock` — centre `cave_ground_center` at y 0, border tiles spanning y 0..1.
 *    The border rises *above* the centre, so the filled region is the walkable floor and
 *    everything outside it is a metre of rock. That is the room.
 *  - `set3 cave_dark_border` — flat, at y 1: the top of that rock, seen from above.
 *  - `set4 d0_miz2` — digs in to −0.5 with `cave_water_center` as its underlay sheet: the
 *    pool. Like every water palette its border slots are partial ramps, so the sheet has to
 *    be laid under the whole region first (DECISIONS #28a).
 *  - `estalactita` hangs from y 3.26 to 8.24, `cave_big_rock` is a 6x6 formation, and
 *    `cave_exit` is the lit mouth.
 */

import { Field, valueNoise, fbm2, scatterSpaced, walkableNear, clamp01, mixTint } from '../compose.js';

export const CAVE = {
  id: 'cave',
  name: 'Hollow Deep',
  preset: 'cave',
  tileset: 'bw2-cave',
  w: 56,
  h: 54,
  weather: null,
  presets: {
    chamber: { marker: 'chamber', distance: 30, dir: 2 },
    mouth: { marker: 'mouth', distance: 30, dir: 2 },
    pool: { marker: 'pool', distance: 28, dir: 2 },
    terrace: { marker: 'terrace', distance: 30, dir: 2 },
    // 46 was a picture of nothing: at that distance the hall is a flat brown rectangle with
    // three light dots in it and a party four pixels tall. At 34 the party and the room's
    // walls read again. Aimed at the terrace because docs/refs/04 is entirely one bank of
    // rock stepping up behind another — though looked at, this framing shows the hall more
    // than it shows the step, so it is better than it was rather than right.
    wide: { marker: 'terrace', distance: 34, dir: 2 },
    close: { marker: 'pool', distance: 16, dir: 2 },
    // `tools/judge/plan.json` shoots `preset: 'route'` for the cave pair and no biome
    // defined one, so it was silently falling back with `presetApplied: false`. The
    // reference is docs/refs/02, a walked cave gallery: the corridor between the hall and
    // the pool, with rock on both sides.
    route: { marker: 'chamber', distance: 26, dir: 2 },
  },
  showcaseDefault: 'chamber',
};

/** A rounded room. Rooms plus the corridors between them is a cave; noise is a sponge. */
function room(field, cx, cz, rx, rz, seed) {
  for (let z = Math.floor(cz - rz - 2); z <= cz + rz + 2; z++) {
    for (let x = Math.floor(cx - rx - 2); x <= cx + rx + 2; x++) {
      const dx = (x + 0.5 - cx) / rx, dz = (z + 0.5 - cz) / rz;
      const wobble = 0.82 + valueNoise(x, z, seed, 5) * 0.34;
      if (dx * dx + dz * dz < wobble) field.set(x, z, 1);
    }
  }
  return field;
}

/** A corridor of a given half-width between two points, with a slight bow. */
function corridor(field, a, b, half, seed) {
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) * 2 + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bow = Math.sin(t * Math.PI) * (valueNoise(i, 3, seed, 8) - 0.5) * 8;
    const x = a[0] + (b[0] - a[0]) * t + bow;
    const z = a[1] + (b[1] - a[1]) * t;
    const r = half + valueNoise(i, 7, seed, 6) * 0.9;
    for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dz * dz <= r * r) field.set(Math.round(x) + dx, Math.round(z) + dz, 1);
      }
    }
  }
  return field;
}

export function buildCave(draft, ctx, palette, rng, log) {
  const W = draft.w, H = draft.h;
  const seed = draft.seed;

  const floorModels = palette.all({ category: 'cave', tags: ['floor', 'flat'], maxCells: 1 }, 'cave floor');
  const stalactites = palette.all({ category: 'prop', tags: ['stalactite'] });
  const bigRock = palette.all({ category: 'cave', tags: ['tall'] }).filter((m) => m.w >= 5)[0] ?? null;
  const exits = palette.all({ category: 'cave', tags: ['cliff', 'tall'] }).filter((m) => m.w === 2 && m.h === 3);
  const mudPatch = palette.all({ category: 'cave', tags: ['floor', 'multicell'] });

  // ------------------------------------------------------------- the hollow
  //
  // Three chambers on a rough diagonal, joined by corridors: the mouth in the south, the
  // main chamber in the middle, a pool chamber off to the east and the deep gallery north.
  const MOUTH = [27, H - 12];
  const HALL = [26, 33];
  const POOL = [40, 21];
  const DEEP = [16, 13];

  const floor = new Field(W, H);
  room(floor, MOUTH[0], MOUTH[1], 5.5, 4, seed ^ 0x11);
  room(floor, HALL[0], HALL[1], 8.5, 5.5, seed ^ 0x22);
  room(floor, POOL[0], POOL[1], 6.5, 5, seed ^ 0x33);
  room(floor, DEEP[0], DEEP[1], 6.5, 4.5, seed ^ 0x44);
  corridor(floor, MOUTH, HALL, 1.9, seed ^ 0x55);
  corridor(floor, HALL, POOL, 1.7, seed ^ 0x66);
  corridor(floor, HALL, DEEP, 2.0, seed ^ 0x77);

  // Outcrops *inside* the rooms. A chamber whose floor is one unbroken sheet reads as a
  // warehouse: what makes rock read as rock is a silhouette interrupting the floor at the
  // scale a walker moves at, and every one of these is a metre of wall with its own lit and
  // shaded faces (the border slots span y 0..1).
  const outcrops = new Field(W, H);
  for (const [ox, oz] of scatterSpaced(rng.fork('outcrops'), {
    rect: { x: 6, z: 6, w: W - 12, h: H - 12 },
    spacing: 9,
    accept: (cx, cz) => floor.get(cx, cz) && fbm2(cx, cz, seed ^ 0xbb, 9, 0.4) > 0.42,
  })) {
    const rx = 1.4 + valueNoise(ox, oz, seed ^ 0xcc, 4) * 2.2;
    room(outcrops, ox, oz, rx, rx * 0.72, seed ^ (ox * 31 + oz));
  }
  outcrops.intersect(floor.clone().shrink(3));
  floor.subtract(outcrops);
  floor.despeckle(6);
  // The rim of the map is always rock, so no frame ever ends in the void.
  floor.subtract(new Field(W, H, (cx, cz) => cx < 3 || cz < 3 || cx > W - 4 || cz > H - 4));

  // ------------------------------------------------------------- the terrace
  //
  // The golden-hour reference is banks of rock stepping up behind each other, and one flat
  // room cannot do that. A second floor a metre higher, cut into the north-west of the
  // hall, gives the frame two levels and a wall between them.
  const terrace = new Field(W, H, (cx, cz) => {
    const a = ((cx + 0.5 - 17) / 7) ** 2 + ((cz + 0.5 - 28) / 4.5) ** 2 < 0.95;
    const b = ((cx + 0.5 - 37) / 5.5) ** 2 + ((cz + 0.5 - 30) / 4) ** 2 < 0.95;
    return (a || b) && valueNoise(cx, cz, seed ^ 0x88, 5) > 0.18;
  });
  terrace.intersect(floor.clone().shrink(1));
  terrace.despeckle(8);
  floor.subtract(terrace);

  // ---------------------------------------------------------------- the pool
  const pool = new Field(W, H, (cx, cz) => {
    const dx = (cx + 0.5 - POOL[0]) / 5.2, dz = (cz + 0.5 - POOL[1]) / 3.6;
    return dx * dx + dz * dz < 0.85 + valueNoise(cx, cz, seed ^ 0x9a, 4) * 0.3;
  });
  pool.intersect(floor.clone().shrink(2));
  // No `closeCorners` here, on purpose: filling the diagonal notches of a *water* region
  // squares it off into a swimming pool. The palette has all four inner-corner slots, so a
  // concave shoreline is something it can draw; the notch fix is for bands of dry path,
  // where the artefact is a stripe of the wrong material down the middle.
  pool.despeckle(8);

  // ---------------------------------------------------------------- the light
  //
  // Declared *before* the drawing because the floor is tinted off it — see `cool` below.
  // The brief asks for "entrance light falling off into darkness", and a preset cannot do
  // that: it can raise the ambient everywhere, which is a lit room, not a cave. What falls
  // off is a *placed* light, so the mouth gets a cold daylight shaft and the deep chambers
  // get a few warm glows to walk towards. `environment`'s cave preset runs `lamps: 1.0` at
  // every hour, so these are on at noon and at midnight alike, which is correct: nothing
  // down here knows what time it is.
  const lights = [
    { x: MOUTH[0] + 0.5, z: MOUTH[1] - 4.5, y: 3.2, color: 0xbfd8ff, intensity: 1.8, radius: 15, size: 0.02 },
    { x: MOUTH[0] + 0.5, z: MOUTH[1] - 0.5, y: 2.2, color: 0xa8c6f0, intensity: 0.9, radius: 12, size: 0.02 },
    { x: HALL[0] + 4.5, z: HALL[1] - 1.5, y: 1.9, color: 0xff9a4a, intensity: 0.9, radius: 10, size: 0.34 },
    // Low, bright and *visible*: the pool read as "a pane of dirty glass over a pit" because
    // its only light was a dim invisible bulb 1.5 units above it. A glowing source sitting on
    // the water at 0.8 lights the sheet from close range and puts an orb in the frame, which
    // is the one cold thing in a room the environment preset fogs warm-brown end to end.
    { x: POOL[0] + 0.5, z: POOL[1] + 0.5, y: 0.8, color: 0x63c8ff, intensity: 2.6, radius: 11, size: 0.55 },
    { x: POOL[0] - 4.5, z: POOL[1] + 3.5, y: 1.4, color: 0x7ce0ff, intensity: 0.85, radius: 9, size: 0.3 },
    { x: DEEP[0] + 1.5, z: DEEP[1] + 0.5, y: 2.0, color: 0xffb060, intensity: 0.95, radius: 11, size: 0.36 },
    { x: 22.5, z: 30.5, y: 1.7, color: 0xff8c3a, intensity: 0.8, radius: 9, size: 0.30 },
  ];

  // --------------------------------------------------------- the floor's hue
  //
  // The single worst thing about round 1's cave was that it had **one colour**: mean
  // saturation 0.971 against docs/refs/02's 0.194, luminance sd 15.4 against 53.7. Every
  // pixel was the same fully-saturated orange, because the only thing varying across the
  // floor was how much of one warm light reached it.
  //
  // A cave is not one colour. Rock away from a flame reads cold and desaturated — that is
  // what the eye does with a dim blue-grey — and rock near one reads warm. So the *albedo*
  // is graded by distance to the nearest bulb, which puts a second hue in the frame that the
  // lighting alone cannot: the far gallery goes slate, the lit floor stays sandstone, and
  // the boundary between them is the falloff rather than a cell edge. The rock top is graded
  // harder than the floor because it is further from every bulb and reads as the far dark.
  const COOL_FLOOR = 0x5f6672;
  const WARM_FLOOR = 0xffffff;
  const COOL_ROCK = 0x333a4c;
  const WARM_ROCK = 0xfff4e6;
  /** 1 where a bulb reaches, 0 in the far dark. Smoothstepped so it is not a disc. */
  function reach(cx, cz) {
    let best = 0;
    for (const L of lights) {
      const dx = cx + 0.5 - L.x, dz = cz + 0.5 - L.z;
      const t = clamp01(1 - Math.sqrt(dx * dx + dz * dz) / (L.radius * 1.05));
      const v = t * t * (3 - 2 * t) * clamp01(L.intensity * 0.9);
      if (v > best) best = v;
    }
    return best;
  }
  const floorTint = (cx, cz) => mixTint(COOL_FLOOR, WARM_FLOOR, reach(cx, cz),
    { jitter: 5, cx, cz, seed: seed ^ 0x2c9f });
  const rockTint = (cx, cz) => mixTint(COOL_ROCK, WARM_ROCK, reach(cx, cz) * 0.85,
    { jitter: 5, cx, cz, seed: seed ^ 0x71a3 });

  // ------------------------------------------------------------- the drawing
  //
  // Order matters and is not alphabetical: the rock top goes down first so the floor's own
  // wall tiles, which rise through y 0..1, are drawn over it rather than under it.
  const rock = floor.clone().union(terrace).invert();
  palette.draw(draft, 'set3', rock, { collision: 'block', layer: 0, tags: ['rock'], tint: rockTint });

  const walkable = floor.clone().subtract(pool);
  palette.draw(draft, 'set0', floor, {
    collision: 'walk', layer: 1, tags: ['cave'], tint: floorTint,
    // The floor is cut out from under the pool. Its water sheet is at −0.25 and the floor
    // quad at 0, so laying both leaves a pond that is drawn, is in the placement list, costs
    // draw calls, and is invisible.
    skip: (cx, cz, kase) => kase === 'center' && pool.get(cx, cz),
  });
  palette.draw(draft, 'set0', terrace, { y0: 1, collision: 'walk', layer: 1, tags: ['cave'], tint: rockTint });
  // The pool shipped as "a grey-tan translucent slab in a hard black rectangle" — water
  // with no colour, because it took the same warm wash as the floor it is cut into. A cold
  // tint on the sheet and a cold bulb *in* it (below) is what makes it read as water rather
  // than as a pane of dirty glass over a pit.
  palette.draw(draft, 'set4', pool, {
    underlay: true, collision: 'water', layer: 2, tags: ['water'],
    tint: (cx, cz) => mixTint(0x77b6e0, 0xdcf4ff, reach(cx, cz),
      { jitter: 6, cx, cz, seed: seed ^ 0x3b71 }),
  });

  // Wet mud where the pool has been and gone — a floor with two materials reads as a place
  // rather than as a fill.
  if (mudPatch.length) {
    const spots = scatterSpaced(rng.fork('mud'), {
      rect: { x: 4, z: 4, w: W - 8, h: H - 8 },
      spacing: 7,
      accept: (cx, cz) => walkable.get(cx, cz) && walkable.get(cx + 2, cz + 2)
        && fbm2(cx, cz, seed ^ 0xaa, 8, 0.4) > 0.5,
    });
    for (const [cx, cz] of spots) {
      draft.place(palette.pick(mudPatch, cx, cz), cx, cz, { collision: 'walk', layer: 2, claim: false });
    }
  }

  // ------------------------------------------------------------- the fittings
  if (bigRock) {
    draft.place(bigRock, 33, 40, { collision: 'block', layer: 3, claim: false });
  }

  // `estalactita` is **not placed**, and that is a measurement rather than taste. It hangs
  // from y 3.26 to 8.24 — five units of geometry that expects a ceiling to hang from — and
  // this cave has no ceiling, because a fixed 45-degree camera looking down at a floor
  // cannot have one. Placed anyway it floats above the rock, and every one of its faces
  // points downward, so after `tiles` clamps normals to the horizon it takes no key at all:
  // on screen it is a black triangle standing on the wall, which reads as a hole in the map.
  // Shot and looked at before it was cut. `stalactites` stays resolved so the omission is
  // visible in `hunts.stats()` rather than silent.
  const stalactitesAvailable = stalactites.length;

  // The mouth: the one place daylight gets in.
  //
  // It stands on the **north** wall of the entrance chamber and not the south one, and that
  // is the camera's arithmetic rather than a story about which way the party came in. A
  // fixed 45-degree camera shows ground from 12.7 cells north of the focus to 8 south, so
  // anything placed south of the framing point is either behind the viewer or cut in half by
  // the bottom edge — the first cut put the exit at `MOUTH + 3` and the `mouth` framing was
  // a picture of an empty floor with a sliver of something at the very bottom.
  //
  // It moved **west** in round 2, and that is the whole of the "opaque pale card renders
  // under the party" fault. At `MOUTH − 1, MOUTH[1] − 6` the exit's 2x3 footprint covered
  // cells (26..27, 36..38), and both the `chamber` marker (26, 38) and the `terrace` marker
  // (26, 36) sat inside it: the party was staged standing *in the lit mouth*, and the pale
  // rounded rectangle the critic measured under the lead Pokemon was the mouth's own
  // daylight geometry seen from above. Proven by removing this one placement and nothing
  // else — the ROI goes from 1.69x its surroundings to 0.93x, i.e. from brighter than the
  // floor to darker than it (DECISIONS #37b). Round 1's comment had blamed a PointLight.
  if (exits.length) {
    draft.place(exits[0], MOUTH[0] - 6, MOUTH[1] - 3, { collision: 'block', layer: 3, claim: false });
  }

  // ------------------------------------------- what the halo is NOT (round 2)
  //
  // Round 1 shipped a comment here blaming the pale card under a party member on "a
  // `PointLight` close to a walker lighting the sprite billboard's transparent margin". That
  // is **wrong**, and four A/Bs at one URL say so (DECISIONS #37):
  //
  //   1. `lights = []` — every placed bulb gone. The card is unchanged: ROI luma 84.0 on a
  //      floor of 44.6, against 87.2/51.7 with all seven bulbs (docs/progress/hunts/r2/
  //      ctl-cave-nolights-12.png).
  //   2. `--envNoCast 1` on top of that — the planar sprite shadows gone too. 84.0. Not
  //      castShadows either.
  //   3. mud patches removed — byte-identical ROI. Not a floor decal.
  //   4. The margin cannot be it in any case: `pokemon/field.js` builds the sprite material
  //      with `alphaTest: 0.5, transparent: false`, so the transparent margin is *discarded*
  //      in the only pass that could light it.
  //
  // What it actually is: **bloom**, and the hue is the tell. The halo is the sprite's own
  // colour blurred, added before tone-mapping, and it is therefore invisible whenever the
  // sprite and the ground it stands on share a hue. In this cave the green party member
  // shows a card on the orange floor and the two orange ones show nothing; in the *forest*,
  // on green ground, it inverts exactly — beside the orange mon the ground reads
  // [118.9, 138.4, 52.1] against [62.1, 144.5, 35.0] two cells away (+57 red), while beside
  // the green mon it is [68.3, 142.0, 40.5], the grass itself. Predicted, then measured.
  //
  // The owner is therefore `core/render.js`'s bright pass together with `environment`'s cave
  // preset, which runs `bloomThreshold: 1.10` — the lowest in the project, against 1.4–2.6
  // outdoors — so an ordinarily-lit sprite crosses it. Filed as a coreRequest with the A/B
  // pair. Nothing in this file can fix it, and the previous mitigation (halving every
  // intensity, doubling every reach) was paying for a fault it never had.

  // Every walkable cell in a cave is an encounter cell — there is no grass down here.
  walkable.forEach((cx, cz) => draft.addTag(cx, cz, 'encounter'));

  // Markers are snapped onto ground a walker can stand on. A framing that teleports the
  // party onto rock collapses the queue onto one cell, which reads as a rendering bug.
  const mark = (name, cx, cz) => {
    const at = walkableNear(draft, cx, cz, 10);
    draft.mark(name, at.cx, at.cz);
    return at;
  };
  const spawnAt = walkableNear(draft, MOUTH[0], MOUTH[1] + 1, 10);
  draft.spawn = { cx: spawnAt.cx, cz: spawnAt.cz, dir: 2 };
  mark('mouth', MOUTH[0], MOUTH[1] + 2);
  mark('chamber', HALL[0], HALL[1] + 5);
  mark('pool', POOL[0] - 1, POOL[1] + 8);
  mark('terrace', 20, 33);   // over the western terrace, and clear of the exit
  mark('deep', DEEP[0] + 2, DEEP[1] + 9);
  mark('spawn', draft.spawn.cx, draft.spawn.cz);

  return {
    stats: {
      floor: floor.count(), terrace: terrace.count(), pool: pool.count(), rock: rock.count(),
      lights: lights.length, stalactitesAvailable,
    },
    lights,
  };
}
