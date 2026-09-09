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

import { Field, valueNoise, fbm2, scatterSpaced, walkableNear, laneNear, clamp01, mixTint, wildCells } from '../compose.js';

export const CAVE = {
  id: 'cave',
  name: 'Hollow Deep',
  preset: 'cave',
  tileset: 'bw2-cave',
  w: 56,
  h: 54,
  /**
   * The trainer level `travel` asks for before it will come here (ARCHITECTURE §5.16).
   *
   * Authored HERE and not in `travel`, because what a destination *is* stays with the
   * scene that owns it. the hardest table: Gible and Larvitar at weight 1, and 0.70x money to pay for it.
   */
  requiredLevel: 20,
  weather: null,
  presets: {
    chamber: { marker: 'chamber', ppu: 32 },
    mouth: { marker: 'mouth', ppu: 32 },
    pool: { marker: 'pool', ppu: 32 },
    terrace: { marker: 'terrace', ppu: 32 },
    // The one preset the zoom ladder cost something. This was distance 34, a *slightly* wider
    // frame than the 30 the other cave shots take — and distance 46 had already been tried and
    // rejected as a picture of nothing, a flat brown rectangle with three light dots in it and
    // a party four pixels tall. The ladder has no rung between 32 and 16, and 16 is the 46 that
    // did not work, so this stays at 32 and is distinguished by its marker alone: aimed at the
    // terrace because docs/refs/04 is one bank of rock stepping up behind another.
    wide: { marker: 'terrace', ppu: 32 },
    // Its own marker, not `pool`'s: at this zoom the near half of the frame is a few cells of
    // ground, and `pool` stood one cell north of a terrace lip. See `mark('close', …)`.
    close: { marker: 'close', ppu: 64 },
    // `tools/judge/plan.json` shoots `preset: 'route'` for the cave pair and no biome
    // defined one, so it was silently falling back with `presetApplied: false`. The
    // reference is docs/refs/02, a walked cave gallery: the corridor between the hall and
    // the pool, with rock on both sides.
    route: { marker: 'gallery', ppu: 32 },
    gallery: { marker: 'gallery', ppu: 32 },
  },
  showcaseDefault: 'gallery',
  /**
   * East along the gallery. See `biomes/forest.js` for why every biome walks east; in a cave
   * it matters twice over, because the rooms are joined by corridors and a corridor a party
   * files *up* is a corridor the camera sees one sprite in.
   */
  walk: { route: 'e14 s2 e8 n2', tiles: 3, subTicks: 7, dir: 3 },
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
  // **Wider east-west than round 3's 6.5, and the reason is the framing rather than the
  // geology.** Two of the cave's eight presets are aimed at this room, and every framing in
  // this module stands the party on a clear east-west lane thirteen cells long (`laneNear`).
  // A room thirteen cells across cannot hold one *and* a body of water, so round 3's marker
  // was pushed out into the hall and the `pool` framing was a picture of the hall. At 8.5 by
  // 5.5 the water sits in the north of the room and the strand along its south is the lane.
  room(floor, POOL[0], POOL[1], 8.5, 5.5, seed ^ 0x33);
  room(floor, DEEP[0], DEEP[1], 6.5, 4.5, seed ^ 0x44);
  corridor(floor, MOUTH, HALL, 1.9, seed ^ 0x55);
  corridor(floor, HALL, POOL, 1.7, seed ^ 0x66);
  corridor(floor, HALL, DEEP, 2.0, seed ^ 0x77);
  // **The gallery**: one long east-west working, drifting a few cells as it runs, cut across
  // the south of the hall.
  //
  // It is the map's answer to the defect all three blind A/B rounds named. Round 2's chambers
  // were joined on a rough north-south diagonal, so an east leg in the route walked into rock,
  // `makeScriptedRoute` dropped it silently, and the party filed up the screen with each
  // sprite hidden behind the one in front and nothing in frame but the back of the trainer's
  // cap. A gallery is also what docs/refs/02 actually is — a walked passage with rock either
  // side — so this is the reference's own composition rather than a concession to the camera.
  const GALLERY = { a: [5, 38], b: [51, 34] };
  corridor(floor, GALLERY.a, GALLERY.b, 2.1, seed ^ 0x99);
  const galleryAt = (cx) => Math.round(GALLERY.a[1]
    + (GALLERY.b[1] - GALLERY.a[1]) * clamp01((cx - GALLERY.a[0]) / (GALLERY.b[0] - GALLERY.a[0])));

  /**
   * **Where the water goes, decided before anything is allowed to eat it.**
   *
   * Round 3 cut the pool last — `pool.intersect(floor.shrink(2))` after the outcrops and the
   * terrace had already been subtracted from `floor` — and on the shipped seed-1337 map that
   * left `pool.count() === 0`. Two framings (`pool` and `close`) are aimed at a body of water
   * that is not in the map, the cold bulb sitting *in* it lights bare rock, and the module's
   * own build report said so in a field nobody read. A region other regions are allowed to
   * carve into is not a region; it is a leftover. So the pool's footprint is declared here
   * and both carvers are told to keep off it.
   */
  const poolTarget = new Field(W, H, (cx, cz) => {
    const dx = (cx + 0.5 - POOL[0]) / 5.6, dz = (cz + 0.5 - (POOL[1] - 1.5)) / 3.0;
    return dx * dx + dz * dz < 0.85 + valueNoise(cx, cz, seed ^ 0x9a, 4) * 0.3;
  });
  const poolKeepOut = poolTarget.clone().grow(3);

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
  // Never *in* the gallery. An outcrop dropped in a two-cell passage is a plug: the east leg
  // is blocked, dropped, and the walk turns north again — which is the whole fault this
  // corridor exists to fix. `Line.place` also lays the entire queue along the walk direction
  // at the teleport, so the row needs about eleven clear cells around the marker, not two.
  outcrops.subtract(new Field(W, H, (cx, cz) => Math.abs(cz - galleryAt(cx)) <= 2));
  outcrops.subtract(poolKeepOut);
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
  terrace.subtract(new Field(W, H, (cx, cz) => Math.abs(cz - galleryAt(cx)) <= 3));
  terrace.subtract(poolKeepOut);
  terrace.despeckle(8);
  floor.subtract(terrace);

  // ---------------------------------------------------------------- the pool
  const pool = poolTarget.clone();
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
  //
  // **The numbers are sized against `environment/lamps.js`, not guessed.** Read off that
  // file: the `PointLight` reach is clamped to `POOL_REACH` 3.9 world units whatever
  // `radius` says, the painted ground pool reaches `min(4.2, radius * 0.42)`, and its
  // strength is `min(1, 0.205 * intensity + 0.035)`. So a bulb at `radius 9, intensity 0.9`
  // — round 2's — paints a pool 3.8 cells across at a fifth of full strength, which is a
  // smudge; the same bulb at `radius 11, intensity 5` paints the full 4.2 cells at full
  // strength. Round 2 asked for wide, dim light and got neither: the room took its colour
  // from the preset's warm fog and every lamp was a dot in it.
  const lights = [
    // The mouth: cold daylight falling in, and the one place in the map that is not lit by
    // something burning.
    { x: MOUTH[0] + 0.5, z: MOUTH[1] - 4.5, y: 3.2, color: 0xbfd8ff, intensity: 5.0, radius: 11, size: 0.02 },
    { x: MOUTH[0] + 0.5, z: MOUTH[1] - 0.5, y: 2.2, color: 0xa8c6f0, intensity: 3.4, radius: 10, size: 0.02 },
    // The warm family: lamps somebody left burning. Fewer and brighter than round 2's seven
    // dim ones, so each is a pool with dark between rather than a wash.
    { x: HALL[0] + 4.5, z: HALL[1] - 1.5, y: 1.9, color: 0xff9a4a, intensity: 5.0, radius: 11, size: 0.34 },
    { x: DEEP[0] + 1.5, z: DEEP[1] + 0.5, y: 2.0, color: 0xffb060, intensity: 4.6, radius: 10, size: 0.36 },
    { x: 22.5, z: 30.5, y: 1.7, color: 0xff8c3a, intensity: 4.2, radius: 10, size: 0.30 },
    // **The cold family, and it is the fix for "one hue".**
    //
    // Round 2's cave measured mean saturation 0.971 against docs/refs/02's 0.194 and luma sd
    // 15.4 against ref04's 37.9 — the flattest scene in the game, essentially every pixel the
    // same fully-saturated orange. No single thing caused it: `environment`'s cave preset
    // fogs warm-brown at density 0.040 with `saturation: 1.30` on top, and *every* light in
    // the room was warm, so fog, key and albedo all pulled the same way and the grade had no
    // second hue to separate. A grade that multiplies saturation by 1.30 is an amplifier —
    // put a real blue in the frame and it comes back stronger — so glowworm light down the
    // gallery and a cold seep in the deep chamber is worth more than any amount of tinting.
    { x: POOL[0] + 0.5, z: POOL[1] + 0.5, y: 0.8, color: 0x63c8ff, intensity: 5.2, radius: 11, size: 0.55 },
    { x: POOL[0] - 4.5, z: POOL[1] + 3.5, y: 1.4, color: 0x7ce0ff, intensity: 4.4, radius: 10, size: 0.30 },
    { x: 14.5, z: 37.5, y: 1.5, color: 0x6fd0ff, intensity: 5.0, radius: 11, size: 0.26 },
    { x: 31.5, z: 36.5, y: 1.6, color: 0x8fe2ff, intensity: 4.8, radius: 11, size: 0.24 },
    { x: 45.5, z: 34.5, y: 1.5, color: 0x63c8ff, intensity: 5.0, radius: 11, size: 0.26 },
    { x: DEEP[0] - 3.5, z: DEEP[1] + 3.5, y: 1.3, color: 0x7fd8ff, intensity: 4.4, radius: 10, size: 0.28 },
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
  // Bluer than round 2's slate, and the falloff is *shorter*. `reach` used the bulb's full
  // radius, and with seven bulbs of radius 9-15 in a 56x54 room that is 1.0 nearly
  // everywhere: the cool end of the ramp was mixed in on almost no cell and the whole floor
  // took `WARM_FLOOR`, which is white — i.e. the albedo grade was a no-op and the room was
  // whatever hue the fog is. Two thirds of the radius puts the far gallery and the corners
  // genuinely on the cold albedo, which is the second hue the frame did not have.
  //
  // **Both ends of that ramp were too far out, and each end shipped as its own defect.**
  // The cold end of the *rock* was 0x1f2740, a near-black navy: multiplied into an already
  // dim rock top it left the ground around every room at luma 0, and the `pool` framing
  // measured **27.3 % of the frame at exactly black** against `docs/refs/02-cave-tilemap.png`
  // at 0.00 % and `04-cave-golden-hour.png` at 0.06 %. Rock in shadow is slate, not a hole in
  // the map. The cold *chill* end was 0xbcdcf6 at weight 0.85, which is a near-white wash: it
  // is what the critic saw as *"a pale grey slab with no rock texture in the cave's west
  // quarter"* — a glowworm bulb painting a full-strength pale blue rectangle across a floor
  // texture that has almost no contrast of its own to survive it. Both are pulled in: the
  // dark end lifts to a slate that still reads as unlit, the pale end drops to a blue that
  // still reads as cold, and the second hue the round-3 note was chasing survives both.
  const COOL_FLOOR = 0x46566e;
  const WARM_FLOOR = 0xffffff;
  const COOL_ROCK = 0x6c7691;
  const WARM_ROCK = 0xfff4e6;
  /** 1 where a bulb reaches, 0 in the far dark. Smoothstepped so it is not a disc. */
  function reach(cx, cz) {
    let best = 0;
    for (const L of lights) {
      const dx = cx + 0.5 - L.x, dz = cz + 0.5 - L.z;
      const t = clamp01(1 - Math.sqrt(dx * dx + dz * dz) / (L.radius * 0.62));
      const v = t * t * (3 - 2 * t) * clamp01(L.intensity * 0.9);
      if (v > best) best = v;
    }
    return best;
  }
  /** How cold the nearest source is, so a floor lit by glowworms is not painted sandstone. */
  function chill(cx, cz) {
    let best = 0, cold = 0;
    for (const L of lights) {
      const dx = cx + 0.5 - L.x, dz = cz + 0.5 - L.z;
      const t = clamp01(1 - Math.sqrt(dx * dx + dz * dz) / (L.radius * 0.62));
      const v = t * t * (3 - 2 * t) * clamp01(L.intensity * 0.9);
      if (v > best) { best = v; cold = ((L.color & 0xff) > ((L.color >> 16) & 0xff)) ? 1 : 0; }
    }
    return best * cold;
  }
  const CHILL_FLOOR = 0x9cc2e6;
  const floorTint = (cx, cz) => mixTint(
    mixTint(COOL_FLOOR, WARM_FLOOR, reach(cx, cz)), CHILL_FLOOR, chill(cx, cz) * 0.55,
    { jitter: 7, cx, cz, seed: seed ^ 0x2c9f },
  );
  const rockTint = (cx, cz) => mixTint(
    mixTint(COOL_ROCK, WARM_ROCK, reach(cx, cz) * 0.85), 0x7f9ab8, chill(cx, cz) * 0.35,
    { jitter: 7, cx, cz, seed: seed ^ 0x71a3 },
  );

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
  // Markers are snapped onto a cell with a **clear east-west lane** through it, not merely
  // onto standable ground: see `laneNear`. A marker in a two-cell passage stacks the queue on
  // one tile and turns the walk north, which is the fault the gallery exists to fix, and the
  // selftest asserts the lane on every preset in every biome.
  const bounds = { x0: 13, x1: W - 14, z0: 13, z1: H - 9 };
  const mark = (name, cx, cz, opts = {}) => {
    const at = laneNear(draft, cx, cz, { maxR: 9, bounds, ...opts });
    draft.mark(name, at.cx, at.cz);
    return at;
  };
  const spawnAt = walkableNear(draft, MOUTH[0], MOUTH[1] + 1, 10);
  draft.spawn = { cx: spawnAt.cx, cz: spawnAt.cz, dir: 3 };
  mark('mouth', MOUTH[0], MOUTH[1] + 2);
  mark('chamber', HALL[0], HALL[1] + 5);
  // On the pool's own south strand, so the water is in the upper half of both framings that
  // aim here rather than twelve cells behind the camera.
  mark('pool', POOL[0] - 2, POOL[1] + 4, { south: 2 });
  /**
   * **`close` has its own marker now, and that is the second regression this round undoes.**
   *
   * It used to borrow `pool` at `distance` 16, which is 6.8 cells of ground north of the
   * focus and **4.3 south**. The pool marker sat one cell north of the eastern terrace's
   * lip, so those 4.3 cells were a metre-high step: the trainer was cut off at the waist,
   * the lead's feet vanished into the riser, and the bottom third of the frame was the flat
   * dark top of the rock below (docs/progress/hunts/r4/base/cave-close-12.png). A tight
   * framing is the one that cannot survive a wall in its near half, so it gets the widest,
   * flattest floor in the map — the middle of the hall, under two of the warm bulbs — and
   * asks `laneNear` for five cells of same-height ground to the south.
   */
  mark('close', HALL[0], HALL[1] + 1, { south: 5 });
  mark('terrace', 20, 33);   // over the western terrace, and clear of the exit
  mark('deep', DEEP[0] + 2, DEEP[1] + 9);
  // The gallery west of the hall, so walking east arrives under the room's own lights with
  // rock on both sides — docs/refs/02's framing exactly.
  const mGallery = mark('gallery', 20, galleryAt(20));
  mark('spawn', draft.spawn.cx, draft.spawn.cz);

  // --------------------------------------------------------- the wild Pokemon
  //
  // There is no grass down here, so every walkable cell is an encounter cell and the wildlife
  // stands wherever the floor is — off the gallery itself, so it is beside the party's route
  // rather than in it.
  const wild = wildCells(rng.fork('wild'), {
    w: W, h: H, seed, markers: [mGallery, draft.marker('chamber'), draft.marker('pool'),
      draft.marker('deep'), draft.marker('mouth')],
    radius: 10, per: 3, spacing: 3.6,
    accept: (cx, cz) => walkable.get(cx, cz) && draft.collisionAt(cx, cz) === 'walk'
      && Math.abs(cz - galleryAt(cx)) > 1,
  });

  return {
    stats: {
      floor: floor.count(), terrace: terrace.count(), pool: pool.count(), rock: rock.count(),
      lights: lights.length, stalactitesAvailable, wild: wild.length,
    },
    lights,
    wild,
  };
}
