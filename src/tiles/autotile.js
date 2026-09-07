/**
 * Auto-tiling driven by PDSMS's own smart-drawing templates.
 *
 * PDSMS ships each terrain transition as a 5x3 palette whose 13 filled slots cover the 13
 * distinct neighbourhoods of a "blob" autotile. The build step already resolved each slot
 * to a tile id and to the neighbour signature from `SmartGrid.smartUnits`, so at runtime we
 * only need the lookup and a fallback for neighbourhoods the palette does not enumerate.
 *
 * Signature bit order (see tools/assets/classify.js): N S W E NW NE SW SE.
 */

const N = 1, S = 2, W = 4, E = 8, NW = 16, NE = 32, SW = 64, SE = 128;

/** Corner bits are only meaningful when both adjacent edges are filled. */
export function normalizeMask(mask) {
  let m = mask & 15;
  if ((mask & NW) && (mask & N) && (mask & W)) m |= NW;
  if ((mask & NE) && (mask & N) && (mask & E)) m |= NE;
  if ((mask & SW) && (mask & S) && (mask & W)) m |= SW;
  if ((mask & SE) && (mask & S) && (mask & E)) m |= SE;
  return m;
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

export function makeAutotiler(sets, modelsById) {
  /** @type {Map<string, {id:string, name:string, table:Map<number,number>, slots:number[]}>} */
  const table = new Map();
  let flipped = false;

  for (const set of sets ?? []) {
    const entries = Object.entries(set.bySignature ?? {}).map(([k, v]) => [Number(k), v]);
    table.set(set.id, {
      id: set.id,
      name: set.name ?? set.id,
      slots: set.slots ?? [],
      raw: entries,
      table: new Map(entries),
      flippedTable: new Map(entries.map(([k, v]) => [flipNS(k), v])),
    });
    // The friendly name is an alias, so callers can say 'grass_path' instead of 'set3'.
    if (set.name && !table.has(set.name)) table.set(set.name, table.get(set.id));
  }

  /** Nearest neighbourhood in Hamming distance, edges weighted above corners. */
  function nearest(t, mask) {
    let best = -1, bestCost = Infinity;
    for (const [sig, tileId] of t) {
      const diff = sig ^ mask;
      const cost = popcount(diff & 15) * 4 + popcount(diff & 0xf0);
      if (cost < bestCost) { bestCost = cost; best = tileId; }
    }
    return best;
  }

  return {
    sets: () => [...new Set([...table.values()])].map((t) => ({ id: t.id, name: t.name, cases: t.table.size })),

    /**
     * @param {string} setId  set id or friendly name
     * @param {number} mask   neighbour bits, N S W E NW NE SW SE
     * @returns {number} tile model id, or -1 if the set is unknown
     */
    solve(setId, mask) {
      const t = table.get(setId);
      if (!t) return -1;
      const m = normalizeMask(mask);
      const active = flipped ? t.flippedTable : t.table;
      const hit = active.get(m);
      return hit !== undefined ? hit : nearest(active, m);
    },

    /**
     * Resolves a whole field at once. `occupancy` is any indexable of truthiness, row-major,
     * `w` wide. Out-of-bounds neighbours count as occupied so the edge of a map does not
     * grow a false border.
     */
    solveField(setId, occupancy, w, h, { outsideIsFilled = true } = {}) {
      const t = table.get(setId);
      const out = new Int32Array(w * h).fill(-1);
      if (!t) return out;
      const at = (x, z) => (x < 0 || z < 0 || x >= w || z >= h)
        ? (outsideIsFilled ? 1 : 0)
        : (occupancy[z * w + x] ? 1 : 0);

      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          if (!occupancy[z * w + x]) continue;
          const mask =
            (at(x, z - 1) ? N : 0) | (at(x, z + 1) ? S : 0) |
            (at(x - 1, z) ? W : 0) | (at(x + 1, z) ? E : 0) |
            (at(x - 1, z - 1) ? NW : 0) | (at(x + 1, z - 1) ? NE : 0) |
            (at(x - 1, z + 1) ? SW : 0) | (at(x + 1, z + 1) ? SE : 0);
          out[z * w + x] = this.solve(setId, mask);
        }
      }
      return out;
    },

    /**
     * PDSMS's smart palette may be laid out bottom-up; if corners come out inverted on
     * screen, flip once here rather than editing every call site (ARCHITECTURE §5.1).
     */
    setFlipped(v) { flipped = !!v; },
    isFlipped: () => flipped,

    /** Debug aid: the tile ids for every enumerated case, in slot order. */
    describe(setId) {
      const t = table.get(setId);
      if (!t) return null;
      return {
        id: t.id, name: t.name,
        cases: [...(flipped ? t.flippedTable : t.table).entries()].map(([sig, tileId]) => ({
          sig, tileId, model: modelsById.get(tileId)?.name ?? null,
        })),
      };
    },
  };
}

export const MASK_BITS = { N, S, W, E, NW, NE, SW, SE };
