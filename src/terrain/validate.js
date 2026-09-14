/**
 * validate.js — checks a `.map.json` (`./mapfile.js`) for the mistakes that would otherwise
 * only surface as a stuck player, an invisible autotile field, or a wild Pokémon nobody's
 * patrol route ever reaches. Pure: no `ctx`, no three.js, no `fetch`, no DOM — every check
 * that can run off the JSON alone does, so both `npm run unit` and the Studio (a page outside
 * `src/`, see `tools/seams/run.js`) get the same answers.
 *
 * Checks that need more than the file itself (a tileset catalog, another map, the encounter
 * table, the loop-stitching algorithm) take it through `env` and self-report as `skipped`
 * rather than silently passing — a check that always says "fine" because it was never asked
 * a real question is worse than one that says nothing.
 */

import { decodeRuns } from './mapfile.js';
import { DIR_DX, DIR_DZ } from '../core/dir.js';

const COLLISION_PASSABLE = new Set(['walk', 'stairs', 'shallow', 'door']);
const HEIGHT_STEP_THRESHOLD = 0.26; // src/hunts/index.js `audit()`'s own crossable-step limit
const LIGHT_POINT_BUDGET = 8;       // src/environment — only the 8 nearest lights get a PointLight
const LIGHT_SIZE_LIMIT = 0.30;      // src/hunts/biomes/meadow.js: "a white disc two hundred pixels wide"

/**
 * @typedef {{code:string, severity:'error'|'warn'|'info', message:string,
 *   at?:{cx:number,cz:number}|{marker:string}|{layer:number}, hint?:string}} Issue
 */

/** Decodes the four cell grids once, for every check to share. */
function decodeGrid(map) {
  const n = map.w * map.h;
  const idx = (cx, cz) => cz * map.w + cx;
  const inside = (cx, cz) => cx >= 0 && cz >= 0 && cx < map.w && cz < map.h;
  const collision = map.grid?.collision ? decodeRuns(map.grid.collision, n) : new Array(n).fill('block');
  const height = map.grid?.height ? decodeRuns(map.grid.height, n) : new Array(n).fill(0);
  const tags = map.grid?.tags ? decodeRuns(map.grid.tags, n) : new Array(n).fill([]);
  return {
    n, idx, inside,
    collisionAt: (cx, cz) => (inside(cx, cz) ? collision[idx(cx, cz)] : 'block'),
    heightAt: (cx, cz) => (inside(cx, cz) ? height[idx(cx, cz)] : 0),
    tagsAt: (cx, cz) => (inside(cx, cz) ? tags[idx(cx, cz)] ?? [] : []),
  };
}

/** Mirrors `MapDraft.passable` exactly (`./draft.js`), off plain decoded arrays. */
function passableOf(grid) {
  return (cx, cz, fromDir) => {
    if (!grid.inside(cx, cz)) return false;
    const kind = grid.collisionAt(cx, cz);
    if (kind === 'ledge') {
      const dir = grid.tagsAt(cx, cz).find((t) => t.startsWith('ledge:'));
      return dir ? Number(dir.slice(6)) === fromDir : false;
    }
    return COLLISION_PASSABLE.has(kind);
  };
}

/**
 * BFS from `start`, four-directional, honouring one-way ledges exactly as the sim does.
 * @returns {Uint8Array} 1 where reachable, indexed by `cz*w+cx`
 */
export function reachableFrom(map, start) {
  const grid = decodeGrid(map);
  const passable = passableOf(grid);
  const seen = new Uint8Array(grid.n);
  if (!start || !grid.inside(start.cx, start.cz)) return seen;
  const startIdx = grid.idx(start.cx, start.cz);
  seen[startIdx] = 1;
  const queue = [[start.cx, start.cz]];
  while (queue.length) {
    const [cx, cz] = queue.shift();
    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + DIR_DX[dir];
      const nz = cz + DIR_DZ[dir];
      if (!grid.inside(nx, nz)) continue;
      const ni = grid.idx(nx, nz);
      if (seen[ni]) continue;
      if (!passable(nx, nz, dir)) continue;
      seen[ni] = 1;
      queue.push([nx, nz]);
    }
  }
  return seen;
}

/** Rotated footprint cells for a placement — `rot & 1` swaps the model's own w/h (`draft.place`). */
export function footprintCells(placement, model) {
  const rot = (placement.rot ?? 0) & 3;
  const fw = rot & 1 ? (model.h ?? 1) : (model.w ?? 1);
  const fh = rot & 1 ? (model.w ?? 1) : (model.h ?? 1);
  const cells = [];
  for (let dz = 0; dz < fh; dz++) for (let dx = 0; dx < fw; dx++) cells.push({ cx: placement.cx + dx, cz: placement.cz + dz });
  return cells;
}

/** Every placement across every `role:"draft"` layer, grid-encoded tiles expanded to objects. */
function allDraftPlacements(map) {
  const out = [];
  for (const layer of map.layers ?? []) {
    if (layer.role === 'extra') continue;
    for (const o of layer.objects ?? []) out.push({ ...o, tileset: layer.tileset, modelName: layer.models?.[o.m] });
    for (const t of layer.tiles ?? []) {
      const n = map.w * map.h;
      const modelAt = decodeRuns(t.model, n);
      for (let i = 0; i < n; i++) {
        if (modelAt[i] < 0) continue;
        out.push({
          m: modelAt[i], cx: i % map.w, cz: Math.floor(i / map.w), layer: t.layer,
          tileset: layer.tileset, modelName: layer.models?.[modelAt[i]],
        });
      }
    }
  }
  return out;
}

/** `'w6 e6'` — a run-length walk (`simulation/route.js`'s own authoring language). */
function parseRouteString(route) {
  const steps = [];
  const DIR = { n: 2, s: 0, e: 3, w: 1 };
  for (const m of String(route ?? '').matchAll(/([nsew])(\d+)/gi)) {
    steps.push({ dir: DIR[m[1].toLowerCase()], n: Number(m[2]) });
  }
  return steps;
}

function markerNames(map) {
  return new Set((map.markers ?? []).map((m) => m.name));
}

// --- individual checks -----------------------------------------------------------------------

const CHECKS = [
  {
    code: 'ledge-no-direction', severity: 'error', needs: [],
    run(map) {
      const grid = decodeGrid(map);
      const out = [];
      for (let cz = 0; cz < map.h; cz++) for (let cx = 0; cx < map.w; cx++) {
        if (grid.collisionAt(cx, cz) !== 'ledge') continue;
        if (!grid.tagsAt(cx, cz).some((t) => t.startsWith('ledge:'))) {
          out.push({ at: { cx, cz }, message: `célula (${cx},${cz}) tem colisão "ledge" sem direção de salto`,
            hint: 'adicione a tag ledge:0..3 (sul/oeste/norte/leste) ou o jogador trava ao encostar.' });
        }
      }
      return out;
    },
  },
  {
    code: 'spawn-not-passable', severity: 'error', needs: [],
    run(map) {
      if (!map.spawn) return [{ message: 'mapa sem spawn definido' }];
      const grid = decodeGrid(map);
      if (!passableOf(grid)(map.spawn.cx, map.spawn.cz, 0) && grid.collisionAt(map.spawn.cx, map.spawn.cz) !== 'ledge') {
        return [{ at: { cx: map.spawn.cx, cz: map.spawn.cz },
          message: `spawn em (${map.spawn.cx},${map.spawn.cz}) não é andável` }];
      }
      return [];
    },
  },
  {
    code: 'marker-missing', severity: 'error', needs: [],
    run(map) {
      const names = markerNames(map);
      const out = [];
      for (const name of map.loop?.via ?? []) {
        if (!names.has(name)) out.push({ at: { marker: name }, message: `loop.via cita o marcador "${name}", que não existe` });
      }
      for (const [id, preset] of Object.entries(map.cameras?.presets ?? {})) {
        if (preset.marker && !names.has(preset.marker)) {
          out.push({ at: { marker: preset.marker }, message: `preset de câmera "${id}" cita o marcador "${preset.marker}", que não existe` });
        }
      }
      return out;
    },
  },
  {
    code: 'unreachable-region', severity: 'warn', needs: [],
    run(map) {
      if (!map.spawn) return [];
      const grid = decodeGrid(map);
      const seen = reachableFrom(map, map.spawn);
      let unreach = 0;
      for (let cz = 0; cz < map.h; cz++) for (let cx = 0; cx < map.w; cx++) {
        const col = grid.collisionAt(cx, cz);
        if (col === 'block' || col === 'water') continue;
        if (!seen[grid.idx(cx, cz)]) unreach++;
      }
      return unreach > 0 ? [{ message: `${unreach} células andáveis inalcançáveis a partir do spawn`, hint: 'sem caminho até o spawn — reveja bordas de altura, cercas e paredes.' }] : [];
    },
  },
  {
    code: 'height-step-no-stairs', severity: 'warn', needs: [],
    run(map) {
      const grid = decodeGrid(map);
      const out = [];
      const seen = new Set();
      for (let cz = 0; cz < map.h; cz++) for (let cx = 0; cx < map.w; cx++) {
        const col = grid.collisionAt(cx, cz);
        if (!COLLISION_PASSABLE.has(col)) continue;
        for (let dir = 0; dir < 4; dir++) {
          const nx = cx + DIR_DX[dir]; const nz = cz + DIR_DZ[dir];
          if (!grid.inside(nx, nz)) continue;
          const ncol = grid.collisionAt(nx, nz);
          if (!COLLISION_PASSABLE.has(ncol)) continue;
          if (col === 'stairs' || ncol === 'stairs' || col === 'ledge' || ncol === 'ledge') continue;
          const dh = Math.abs(grid.heightAt(cx, cz) - grid.heightAt(nx, nz));
          if (dh <= HEIGHT_STEP_THRESHOLD) continue;
          const key = [cx, cz, nx, nz].sort().join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ at: { cx, cz }, message: `degrau de altura (${dh.toFixed(2)}) entre (${cx},${cz}) e (${nx},${nz}) sem escada nem degrau de salto` });
        }
      }
      return out;
    },
  },
  {
    code: 'closed-loop', severity: 'info', needs: [],
    run(map) {
      const r = map.loop?.resolved;
      if (!r?.cells?.length) return [];
      return [{ message: `loop de caça fechado com ${r.cells.length} células, ${r.corners ?? '?'} curvas`, at: { cx: r.start?.cx, cz: r.start?.cz } }];
    },
  },
  {
    code: 'spawn-point-blocked', severity: 'error', needs: [],
    run(map) {
      const points = map.spawnPoints ?? [];
      if (!points.length) return [];
      const grid = decodeGrid(map);
      const passable = passableOf(grid);
      const out = [];
      for (const p of points) {
        if (!passable(p.cx, p.cz, p.dir ?? 0)) {
          out.push({ at: { cx: p.cx, cz: p.cz }, message: `ponto de spawn em (${p.cx},${p.cz}) está numa célula bloqueada` });
        }
      }
      return out;
    },
  },
  {
    code: 'camera-coverage', severity: 'info', needs: [],
    run(map) {
      const presets = Object.keys(map.cameras?.presets ?? {});
      if (!presets.length) return [];
      return [{ message: `${presets.length} preset(s) de câmera definidos: ${presets.join(', ')}` }];
    },
  },
  {
    code: 'npc-cell-blocked', severity: 'warn', needs: [],
    run(map) {
      const grid = decodeGrid(map);
      const out = [];
      for (const n of map.npcs ?? []) {
        if (!grid.inside(n.cx, n.cz)) { out.push({ message: `NPC "${n.name}" fora do mapa (${n.cx},${n.cz})` }); continue; }
        const col = grid.collisionAt(n.cx, n.cz);
        if (!COLLISION_PASSABLE.has(col)) out.push({ at: { cx: n.cx, cz: n.cz }, message: `NPC "${n.name}" está numa célula bloqueada (${n.cx},${n.cz})` });
      }
      return out;
    },
  },
  {
    code: 'npc-route-leaves-map', severity: 'warn', needs: [],
    run(map) {
      const grid = decodeGrid(map);
      const out = [];
      for (const n of map.npcs ?? []) {
        if (!n.route) continue;
        let cx = n.cx; let cz = n.cz;
        for (const step of parseRouteString(n.route)) {
          for (let i = 0; i < step.n; i++) {
            cx += DIR_DX[step.dir]; cz += DIR_DZ[step.dir];
            if (!grid.inside(cx, cz)) { out.push({ message: `rota de "${n.name}" sai do mapa em (${cx},${cz})` }); return out; }
          }
        }
      }
      return out;
    },
  },
  {
    code: 'light-budget', severity: 'warn', needs: [],
    run(map) {
      const pointLights = (map.lights ?? []).filter((l) => l.point !== false);
      if (pointLights.length > LIGHT_POINT_BUDGET) {
        return [{ message: `${pointLights.length} luzes de ponto no mapa — só as ${LIGHT_POINT_BUDGET} mais próximas da câmera recebem PointLight; o resto fica sem brilho.` }];
      }
      return [];
    },
  },
  {
    code: 'light-size', severity: 'warn', needs: [],
    run(map) {
      return (map.lights ?? [])
        .filter((l) => (l.size ?? 0) > LIGHT_SIZE_LIMIT)
        .map((l) => ({ at: { cx: Math.round(l.x), cz: Math.round(l.z) },
          message: `luz "${l.n ?? ''}" com size ${l.size} — acima de ${LIGHT_SIZE_LIMIT} vira um disco branco na tela` }));
    },
  },
  // --- checks that need context beyond the file itself ---------------------------------------
  {
    code: 'model-unresolved', severity: 'error', needs: ['catalogs'],
    run(map, env) {
      const out = [];
      for (const layer of map.layers ?? []) {
        const cat = env.catalogs[layer.tileset];
        if (!cat) continue;
        (layer.models ?? []).forEach((name, i) => {
          if (!cat.byName?.has(name)) out.push({ message: `modelo "${name}" não encontrado na tileset "${layer.tileset}"`, at: { layer: i } });
        });
      }
      return out;
    },
  },
  {
    code: 'autotile-set-missing', severity: 'error', needs: ['catalogs'],
    run(map, env) {
      const out = [];
      for (const r of map.regions ?? []) {
        const cat = env.catalogs[r.tileset];
        if (cat && !cat.autotileSets?.includes(r.set)) {
          out.push({ message: `região autotile cita o conjunto "${r.set}", que não existe em "${r.tileset}" — a região não desenha nada` });
        }
      }
      return out;
    },
  },
  {
    code: 'footprint-overlap', severity: 'error', needs: ['catalogs'],
    run(map, env) {
      const claimed = new Map();
      const out = [];
      for (const p of allDraftPlacements(map)) {
        const cat = env.catalogs[p.tileset];
        const model = cat?.byName?.get(p.modelName);
        if (!model || ((model.w ?? 1) === 1 && (model.h ?? 1) === 1)) continue;
        for (const c of footprintCells(p, model)) {
          const key = `${c.cx},${c.cz}`;
          if (claimed.has(key)) out.push({ at: c, message: `"${p.modelName}" em (${p.cx},${p.cz}) sobrepõe "${claimed.get(key)}" na célula (${c.cx},${c.cz})` });
          else claimed.set(key, p.modelName);
        }
      }
      return out;
    },
  },
  {
    code: 'footprint-off-map', severity: 'error', needs: ['catalogs'],
    run(map, env) {
      const out = [];
      for (const p of allDraftPlacements(map)) {
        const cat = env.catalogs[p.tileset];
        const model = cat?.byName?.get(p.modelName);
        if (!model) continue;
        for (const c of footprintCells(p, model)) {
          if (c.cx < 0 || c.cz < 0 || c.cx >= map.w || c.cz >= map.h) {
            out.push({ message: `"${p.modelName}" em (${p.cx},${p.cz}) ultrapassa a borda do mapa` });
            break;
          }
        }
      }
      return out;
    },
  },
  {
    code: 'door-no-arrival', severity: 'error', needs: ['maps'],
    run(map, env) {
      const out = [];
      for (const link of map.links ?? []) {
        const dest = env.maps[link.to?.map];
        if (!dest) { out.push({ message: `link "${link.id}" aponta para o mapa "${link.to?.map}", que não foi encontrado` }); continue; }
        if (link.to?.marker && !markerNames(dest).has(link.to.marker)) {
          out.push({ message: `link "${link.id}" aponta para o marcador "${link.to.marker}" em "${link.to.map}", que não existe lá` });
        }
      }
      return out;
    },
  },
  {
    code: 'spawn-point-species', severity: 'error', needs: ['species'],
    run(map, env) {
      const out = [];
      for (const p of map.spawnPoints ?? []) {
        const rows = p.species ?? [];
        if (!rows.length) {
          out.push({ at: { cx: p.cx, cz: p.cz }, message: `ponto de spawn em (${p.cx},${p.cz}) não tem nenhuma espécie` });
          continue;
        }
        for (const r of rows) {
          if (!(Number(r.chance) > 0)) {
            out.push({ at: { cx: p.cx, cz: p.cz }, message: `"${r.name}" em (${p.cx},${p.cz}) tem chance ${r.chance} (deve ser positiva)` });
          }
          if (!env.species.has(r.name)) {
            out.push({ at: { cx: p.cx, cz: p.cz }, message: `"${r.name}" em (${p.cx},${p.cz}) não é uma espécie conhecida` });
          }
        }
      }
      return out;
    },
  },
  {
    code: 'loop-stale', severity: 'warn', needs: ['loop'],
    run(map, env) {
      if (!map.loop?.via?.length) return [];
      const fresh = env.loop.stitch(map, map.loop.via);
      const cached = map.loop.resolved;
      if (!fresh && cached) return [{ message: 'o loop de patrulha autorado não fecha mais contra o mapa atual — repinte ou reordene os marcadores' }];
      if (fresh && cached && JSON.stringify(fresh.cells) !== JSON.stringify(cached.cells)) {
        return [{ message: 'o loop de patrulha em cache está desatualizado — clique em "revalidar" para recalcular' }];
      }
      return [];
    },
  },
];

/**
 * @param {object} map a parsed map file
 * @param {{catalogs?: Record<string,{byName:Map<string,object>, autotileSets?:string[]}>,
 *   maps?: Record<string,object>, tables?: Record<string,object[]>,
 *   loop?: {stitch:(map:object, via:string[]) => object|null}}} [env]
 * @returns {{errors:Issue[], warnings:Issue[], infos:Issue[], skipped:string[], stats:object}}
 */
export function validateMap(map, env = {}) {
  const errors = [];
  const warnings = [];
  const infos = [];
  const skipped = [];

  for (const check of CHECKS) {
    const missing = check.needs.filter((k) => env[k] === undefined);
    if (missing.length) { skipped.push(check.code); continue; }
    let issues;
    try {
      issues = check.run(map, env) ?? [];
    } catch (err) {
      errors.push({ code: check.code, severity: 'error', message: `checagem "${check.code}" falhou: ${err.message}` });
      continue;
    }
    for (const issue of issues) {
      const full = { code: check.code, severity: check.severity, ...issue };
      (check.severity === 'error' ? errors : check.severity === 'warn' ? warnings : infos).push(full);
    }
  }

  return {
    errors, warnings, infos, skipped,
    stats: { checks: CHECKS.length, ran: CHECKS.length - skipped.length },
  };
}

export { CHECKS };
