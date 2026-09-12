/**
 * Auto-tiling driven by PDSMS's own smart-drawing templates.
 *
 * PDSMS ships each terrain transition as a 5x3 palette whose 13 filled slots cover the 13
 * distinct neighbourhoods of a "blob" autotile. The build step already resolved each slot
 * to a tile id and to the neighbour signature from `SmartGrid.smartUnits`, so at runtime we
 * only need the lookup, a fallback for neighbourhoods the palette does not enumerate, and
 * the *vertical* bookkeeping the palette does not carry (below).
 *
 * Signature bit order (see tools/assets/classify.js): N S W E NW NE SW SE.
 *
 * Three kinds of set exist in the AdAstra data and they are not interchangeable:
 *
 *  - `surface` — grass/path, lake shore, shallows. Every slot lives in one plane; the
 *    filled region is a *material* change and nothing moves in Y.
 *  - `plateau` — the mountain and tall-mountain sets. The border slots are **banks**: a
 *    tile whose geometry climbs from y=0 at the outside to y=`riseY` at the inside. The
 *    filled region is therefore a raised platform, and its interior fill has to be lifted
 *    to `riseY` or the plateau reads as a bowl. The palette's own centre slot is authored
 *    at an arbitrary height (`stone_path_center` at 0, `cliff_top_center` at 5), so the
 *    lift is `riseY - centre.baseY`, not `riseY`.
 *  - `line` — the fences. These are *not* blobs. A fence tile is a billboard through the
 *    middle of its cell with one arm per connected side, so what decides the tile is
 *    4-way connectivity, not an 8-neighbour region signature. The palette maps its 13 blob
 *    slots onto the six pieces that exist, which is lossy in both directions; we ignore it
 *    and read each piece's real arms off its geometry instead (`armsOf` in index.js).
 */

const N = 1, S = 2, W = 4, E = 8, NW = 16, NE = 32, SW = 64, SE = 128;
const EDGES = N | S | W | E;

/** The 13 neighbourhoods a PDSMS smart palette enumerates, in palette reading order. */
export const BLOB_CASES = [
  { name: 'corner_nw', sig: 10 }, { name: 'edge_n', sig: 14 }, { name: 'corner_ne', sig: 6 },
  { name: 'edge_w', sig: 11 }, { name: 'center', sig: 255 }, { name: 'edge_e', sig: 7 },
  { name: 'corner_sw', sig: 9 }, { name: 'edge_s', sig: 13 }, { name: 'corner_se', sig: 5 },
  { name: 'inner_nw', sig: 239 }, { name: 'inner_ne', sig: 223 },
  { name: 'inner_sw', sig: 191 }, { name: 'inner_se', sig: 127 },
];
const CASE_BY_SIG = new Map(BLOB_CASES.map((c) => [c.sig, c.name]));

/**
 * Reduces an 8-neighbour signature to the 13-case alphabet a PDSMS smart palette speaks.
 *
 * The rule is the one the palette itself is built on, and getting it wrong is the classic
 * autotiling bug: **a diagonal only means anything once all four edges are filled.** An
 * outer corner tile is chosen because two edges are missing, and whatever sits on the
 * diagonal between them is hidden by the tile's own transition — so the corner bits are
 * noise there and must be dropped, or a plain rectangle's corner cell hashes to a mask the
 * palette never enumerated (`S|E|SE`, not `S|E`) and falls through to the nearest-match
 * path on every single cell of every border.
 *
 * With all four edges filled the diagonals are exactly what distinguishes the centre tile
 * from the four inner corners, so there they are kept.
 */
export function normalizeMask(mask) {
  const edges = mask & EDGES;
  return edges === EDGES ? (EDGES | (mask & 0xf0)) : edges;
}

/** Vertically mirrors a signature: swaps N<->S and the corners across the horizontal axis. */
function flipNS(mask) {
  let out = 0;
  if (mask & N) out |= S;
  if (mask & S) out |= N;
  if (mask & W) out |= W;
  if (mask & E) out |= E;
  if (mask & NW) out |= SW;
  if (mask & NE) out |= SE;
  if (mask & SW) out |= NW;
  if (mask & SE) out |= NE;
  return out;
}

/** How many bits differ — used to pick the closest available slot for a novel neighbourhood. */
const popcount = (x) => {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
};

/**
 * @param {Array} rawSets              `pack.autotileSets`
 * @param {Map<number, object>} byId   every model in the tileset, by id
 * @param {object[]} allModels         the same models as a list (for fallbacks / fence family)
 */
export function makeAutotiler(rawSets, byId, allModels = []) {
  /** @type {Map<string, object>} */
  const table = new Map();
  let flipped = false;

  /** A flat 1x1 ground tile to stand in for a palette that never shipped a centre slot. */
  const fallbackGround = allModels.find((m) =>
    m.category === 'ground' && m.w === 1 && m.h === 1 && (m.baseY ?? 0) < 0.5) ?? null;

  for (const raw of rawSets ?? []) {
    const entries = Object.entries(raw.bySignature ?? {}).map(([k, v]) => [Number(k), v]);
    const border = entries.filter(([sig]) => sig !== 255).map(([, id]) => byId.get(id)).filter(Boolean);
    const centreEntry = entries.find(([sig]) => sig === 255) ?? null;
    const centre = centreEntry ? byId.get(centreEntry[1]) ?? null : null;

    const categories = [...new Set(border.map((m) => m.category))];
    const riseY = border.length ? Math.max(...border.map((m) => m.bounds?.max?.[1] ?? 0)) : 0;
    const sinkY = border.length ? Math.min(...border.map((m) => m.bounds?.min?.[1] ?? 0)) : 0;

    // A bank that climbs a meaningful distance above the outside ground makes this a raised
    // platform; a coastal cliff that only *descends* (sea_cliff, riseY 0) does not.
    const isLine = categories.includes('fence');
    const isPlateau = !isLine && categories.includes('cliff') && riseY > 0.25;
    const kind = isLine ? 'line' : isPlateau ? 'plateau' : 'surface';

    // Two palettes (mountain v2, sea_cliff) ship no centre slot at all, which would leave a
    // hole where the platform's own surface belongs. A flat ground tile stands in, lifted
    // to whatever height the banks climb to.
    let centreModel = centre;
    let centreIsFallback = false;
    if (!centreModel && categories.includes('cliff') && fallbackGround) {
      centreModel = fallbackGround;
      centreIsFallback = true;
    }
    // The palette's centre tile is authored wherever the artist happened to draw it, so the
    // lift is measured, never assumed. Surface sets keep their authored offset (the path
    // sits 0.07 above the lawn on purpose; the lake surface sits 0.5 below the bank).
    const centreY = centreModel && (kind === 'plateau' || centreIsFallback)
      ? riseY - (centreModel.baseY ?? 0) : 0;

    const cases = new Map();
    for (const [sig, id] of entries) {
      if (sig === 255) continue;
      cases.set(sig, { modelId: id, y: 0, name: CASE_BY_SIG.get(sig) ?? `sig${sig}` });
    }
    if (centreModel) cases.set(255, { modelId: centreModel.id, y: centreY, name: 'center' });

    const missing = BLOB_CASES.filter((c) => !cases.has(c.sig)).map((c) => c.name);

    // A region whose geometry drops below the surrounding ground plane cannot simply be
    // laid on top of it: the map's own ground has to be cut away under the region first, or
    // a lake is an invisible hole under an unbroken lawn. And a water set's centre tile is
    // not just the fill for the middle — it is the *sheet* the shore tiles sit on, because
    // every one of them is a partial ramp that leaves the rest of its cell empty.
    const digsIn = sinkY < -0.05;
    /** Every slot lives in one plane, so the whole region can be shifted flush with a floor. */
    const flat = (riseY - sinkY) < 0.05;
    const underlay = centreModel && centreModel.category === 'water'
      ? { modelId: centreModel.id, y: centreY } : null;

    const set = {
      id: raw.id,
      name: raw.name ?? raw.id,
      kind, riseY: kind === 'plateau' ? riseY : 0, sinkY, digsIn, flat, underlay,
      categories,
      slots: raw.slots ?? [],
      cases,
      centre: centreModel ? { modelId: centreModel.id, y: centreY, name: centreModel.name } : null,
      centreIsFallback,
      missing,
      table: new Map(entries),
      flippedTable: new Map(entries.map(([k, v]) => [flipNS(k), v])),
      arms: null,
      models: border.concat(centreModel ? [centreModel] : []),
    };

    if (isLine) buildArms(set, byId, allModels);
    table.set(set.id, set);
    // The friendly name is an alias so callers can say 'lake' instead of 'set1'. Several
    // palettes share a name ('mountain' x3), so first one wins and the ids stay canonical.
    if (raw.name && !table.has(raw.name)) table.set(raw.name, set);
  }

  /**
   * Fence pieces are identified by the arms their geometry actually has, not by the blob
   * slot the palette parked them in — `fence_corner_corner_sw` connects north and east.
   * The family is every model in the same category that shares the palette's own materials,
   * which is what separates the two fence variants (saku.png vs saku01a.png) and pulls in
   * `fence_cross`, a piece the palette has no slot for at all.
   */
  function buildArms(set, byIdMap, models) {
    // The runtime pack carries materials per geometry group, not as a flat list.
    const matsOf = (m) => m.materials ?? (m.groups ?? []).map((g) => g.material);
    const shared = set.models.reduce(
      (acc, m) => acc.filter((id) => matsOf(m).includes(id)),
      [...matsOf(set.models[0] ?? {})],
    );
    // Without a real material intersection every fence in the tileset joins every family and
    // the second variant silently renders as the first.
    const family = models.filter((m) =>
      set.categories.includes(m.category) && shared.length > 0
      && shared.every((id) => matsOf(m).includes(id)));

    const arms = new Map();
    for (const m of family) {
      if (!m.arms) continue;
      if (!arms.has(m.arms)) arms.set(m.arms, m.id);
    }
    set.arms = arms;
    set.family = family.map((m) => m.id);
    set.missing = [
      ...(arms.has(N | W | E) || arms.has(EDGES) ? [] : ['tee']),
      ...(arms.has(EDGES) ? [] : ['cross']),
    ];
  }

  /** Nearest neighbourhood in Hamming distance; edges dominate corners absolutely. */
  function nearest(t, mask) {
    let best = -1, bestCost = Infinity, bestSig = Infinity;
    for (const [sig, entry] of t) {
      const diff = sig ^ mask;
      const cost = popcount(diff & EDGES) * 16 + popcount(diff & 0xf0);
      if (cost < bestCost || (cost === bestCost && sig < bestSig)) {
        bestCost = cost; best = entry; bestSig = sig;
      }
    }
    return best;
  }

  /** 4-way connectivity -> the fence piece whose arms match. */
  function solveLine(set, conn) {
    const arms = set.arms;
    if (!arms || !arms.size) return null;
    const exact = arms.get(conn);
    if (exact !== undefined) return { modelId: exact, y: 0, name: armName(conn) };
    // Three- and four-way junctions: the data has a cross but no tee, so a tee borrows it.
    if (popcount(conn) >= 3) {
      const cross = arms.get(EDGES);
      if (cross !== undefined) return { modelId: cross, y: 0, name: armName(conn) };
    }
    // One arm, or none: run the straight along whichever axis is connected.
    const wantNS = (conn & (N | S)) !== 0 && (conn & (W | E)) === 0;
    const straight = arms.get(wantNS ? (N | S) : (W | E)) ?? arms.get(N | S) ?? arms.get(W | E);
    return straight !== undefined ? { modelId: straight, y: 0, name: armName(conn) } : null;
  }

  const armName = (conn) => (conn === 0 ? 'post'
    : ['', 'n', 's', 'ns', 'w', 'nw', 'sw', 'nsw', 'e', 'ne', 'se', 'nse', 'we', 'nwe', 'swe', 'cross'][conn & 15]);

  const api = {
    /** Metadata every world builder needs before it places a set. */
    sets: () => [...new Set(table.values())].map((t) => ({
      id: t.id, name: t.name, kind: t.kind, riseY: t.riseY, sinkY: t.sinkY,
      /** The map's own ground must be cleared under this region before it is placed. */
      digsIn: t.digsIn,
      /** Every slot is in one plane: `y0 = -sinkY` sets the whole region flush with a floor. */
      flat: t.flat,
      /** A sheet to lay under every cell of the region (water). null when there is none. */
      underlay: t.underlay ? { ...t.underlay } : null,
      categories: t.categories, cases: t.kind === 'line' ? (t.arms?.size ?? 0) : t.cases.size,
      missing: t.missing, centre: t.centre?.name ?? null, centreIsFallback: t.centreIsFallback,
    })),

    /** The raw record, for the showcase and the debug overlay. */
    set: (setId) => table.get(setId) ?? null,

    /** Case name for a normalised signature, e.g. 255 -> 'center'. */
    caseName: (sig) => CASE_BY_SIG.get(normalizeMask(sig)) ?? null,

    /**
     * @param {string} setId  set id or friendly name
     * @param {number} mask   neighbour bits, N S W E NW NE SW SE
     * @returns {number} tile model id, or -1 if the set is unknown or has no usable slot
     */
    solve(setId, mask) {
      const hit = api.resolve(setId, mask);
      return hit ? hit.modelId : -1;
    },

    /**
     * Like `solve` but also returns the vertical offset the case needs and the case name.
     * `strict` refuses to substitute a near-miss slot, which is what the showcase uses so a
     * palette gap shows up as a hole instead of as a wrong-shaped tile.
     * @returns {{modelId:number, y:number, name:string}|null}
     */
    resolve(setId, mask, { strict = false } = {}) {
      const t = table.get(setId);
      if (!t) return null;
      if (t.kind === 'line') return solveLine(t, mask & EDGES);

      const m = normalizeMask(mask);
      if (flipped) {
        const id = t.flippedTable.get(m);
        return id === undefined ? null : { modelId: id, y: 0, name: CASE_BY_SIG.get(m) ?? `sig${m}` };
      }
      const hit = t.cases.get(m);
      if (hit) return hit;
      if (strict) return null;
      const near = nearest(t.cases, m);
      return near === -1 ? null : near;
    },

    /** True when the palette enumerates this exact neighbourhood. */
    covers(setId, mask) {
      const t = table.get(setId);
      if (!t) return false;
      return t.kind === 'line' ? !!t.arms?.has(mask & EDGES) : t.cases.has(normalizeMask(mask));
    },

    /** The 8-neighbour signature of a cell in an occupancy field. */
    maskAt(occupancy, w, h, x, z, outsideIsFilled = true) {
      const at = (px, pz) => (px < 0 || pz < 0 || px >= w || pz >= h)
        ? (outsideIsFilled ? 1 : 0)
        : (occupancy[pz * w + px] ? 1 : 0);
      return (at(x, z - 1) ? N : 0) | (at(x, z + 1) ? S : 0) |
        (at(x - 1, z) ? W : 0) | (at(x + 1, z) ? E : 0) |
        (at(x - 1, z - 1) ? NW : 0) | (at(x + 1, z - 1) ? NE : 0) |
        (at(x - 1, z + 1) ? SW : 0) | (at(x + 1, z + 1) ? SE : 0);
    },

    /**
     * Resolves a whole field at once. `occupancy` is any indexable of truthiness, row-major,
     * `w` wide. Out-of-bounds neighbours count as occupied for region sets so the edge of a
     * map does not grow a false border; for fences the opposite is true, a run that reaches
     * the map edge should end there.
     * @returns {Int32Array} model id per cell, -1 where nothing is placed.
     */
    solveField(setId, occupancy, w, h, opts = {}) {
      const out = new Int32Array(w * h).fill(-1);
      for (const p of api.solvePlacements(setId, occupancy, w, h, opts)) {
        out[p.cz * w + p.cx] = p.modelId;
      }
      return out;
    },

    /**
     * The form world builders should prefer: every cell resolved to a ready-to-place
     * `{ modelId, cx, cz, y, rot, case }`, with the plateau lift already applied to the
     * interior fill. `y0` shifts the whole region (a plateau on top of another plateau).
     *
     * `underlay: true` additionally lays the set's water sheet under every cell of the
     * region *before* the border tiles. Every lake and shallows tile is a partial ramp that
     * leaves the rest of its cell empty — without the sheet a shoreline is a ring of holes
     * with the sky showing through, which is exactly what it looked like.
     * @returns {Array<{modelId:number, cx:number, cz:number, y:number, rot:0, case:string}>}
     */
    solvePlacements(setId, occupancy, w, h, opts = {}) {
      const t = table.get(setId);
      const out = [];
      if (!t) return out;
      const outside = opts.outsideIsFilled ?? (t.kind !== 'line');
      const strict = !!opts.strict;
      const y0 = opts.y0 ?? 0;

      if (opts.underlay && t.underlay) {
        for (let z = 0; z < h; z++) {
          for (let x = 0; x < w; x++) {
            if (!occupancy[z * w + x]) continue;
            out.push({
              modelId: t.underlay.modelId, cx: x, cz: z,
              y: y0 + t.underlay.y, rot: 0, case: 'underlay',
            });
          }
        }
      }

      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          if (!occupancy[z * w + x]) continue;
          const mask = api.maskAt(occupancy, w, h, x, z, outside);
          const hit = api.resolve(setId, mask, { strict });
          if (!hit) continue;
          out.push({ modelId: hit.modelId, cx: x, cz: z, y: y0 + hit.y, rot: 0, case: hit.name });
        }
      }
      return out;
    },

    /**
     * PDSMS's smart palette may be laid out bottom-up; if corners come out inverted on
     * screen, flip once here rather than editing every call site (src/tiles/index.js).
     * The source orientation is already correct, so this stays unused.
     */
    setFlipped(v) { flipped = !!v; },
    isFlipped: () => flipped,

    /** Debug aid: every enumerated case with its model, in palette reading order. */
    describe(setId) {
      const t = table.get(setId);
      if (!t) return null;
      if (t.kind === 'line') {
        return {
          id: t.id, name: t.name, kind: t.kind, missing: t.missing,
          cases: [...(t.arms ?? [])].map(([conn, modelId]) => ({
            sig: conn, name: armName(conn), modelId, model: byId.get(modelId)?.name ?? null, y: 0,
          })),
        };
      }
      return {
        id: t.id, name: t.name, kind: t.kind, riseY: t.riseY, missing: t.missing,
        cases: BLOB_CASES.map(({ name, sig }) => {
          const hit = t.cases.get(sig);
          return {
            sig, name, modelId: hit?.modelId ?? -1, y: hit?.y ?? 0,
            model: hit ? byId.get(hit.modelId)?.name ?? null : null,
          };
        }),
      };
    },
  };

  return api;
}

export const MASK_BITS = { N, S, W, E, NW, NE, SW, SE };

/**
 * The arms a thin billboard piece actually has, read off its geometry: a vertical quad in
 * the x=0.5 plane that reaches z<0.4 is a north arm, and so on. Horizontal rails and cast
 * shadow decals are excluded by their zero height. This is how the fence sets are solved
 * without trusting names the classifier derived from a palette slot.
 *
 * @param {Float32Array} view  the interleaved vertex buffer
 * @param {{groups: {offset:number, count:number}[]}} model
 * @param {number} stride      floats per vertex
 * @returns {number} N|S|W|E bitmask, 0 when the model is not a thin billboard piece
 */
export function armsOf(view, model, stride) {
  let arms = 0;
  for (const g of model.groups ?? []) {
    const start = (g.offset ?? 0) / 4;
    for (let i = 0; i < g.count; i += 3) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let k = 0; k < 3; k++) {
        const o = start + (i + k) * stride;
        const x = view[o], y = view[o + 1], z = view[o + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      if (maxY - minY < 0.3) continue;                       // a rail or a shadow, not an arm
      if (maxX - minX < 0.12 && Math.abs((minX + maxX) / 2 - 0.5) < 0.12) {
        if (minZ < 0.4) arms |= N;
        if (maxZ > 0.6) arms |= S;
      } else if (maxZ - minZ < 0.12 && Math.abs((minZ + maxZ) / 2 - 0.5) < 0.12) {
        if (minX < 0.4) arms |= W;
        if (maxX > 0.6) arms |= E;
      }
    }
  }
  return arms;
}
