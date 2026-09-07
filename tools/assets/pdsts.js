/**
 * Reader for Pokemon DS Map Studio `.pdsts` tilesets.
 *
 * The format is a flat tag-length-value stream, big-endian throughout, ported from
 * `src/main/java/tileset/TilesetIO.java` in the PDSMS source tree. Materials come first
 * (bracketed by MATERIAL_START/MATERIAL_END), then the smart grids, then the tiles.
 *
 * Geometry lives in OBJ conventions: 1-based indices into flat coordinate arrays, faces
 * split into quads and tris, and each tile's faces sorted so that texture k covers the
 * face range [texOffsets[k], texOffsets[k+1]).
 */

import { readFileSync } from 'node:fs';

const TAG = {
  0: 'TILE', 1: 'IMG_NAME', 2: 'PNAME_IMD', 3: 'TNAME_IMD', 4: 'MAT_NAME',
  9: 'MAT_START', 10: 'MAT_END', 11: 'WIDTH', 12: 'HEIGHT', 13: 'XTILEABLE',
  14: 'YTILEABLE', 15: 'VCOORDS', 16: 'TCOORDS', 17: 'FINDSQUADS', 18: 'FINDSTRIS',
  19: 'TIDS', 21: 'OBJNAME', 22: 'NCOORDS', 23: 'ZOFFSET', 24: 'TOFFSETSQUAD',
  25: 'TOFFSETSTRI', 26: 'SMARTGRID', 27: 'GLOBALMAPPING', 28: 'GLOBALTEXSCALE',
  30: 'FOG', 31: 'BOTHFACE', 32: 'NORMALORIENT', 33: 'ALPHA', 34: 'TEXGENMODE',
  35: 'INCLUDE_IN_IMD', 36: 'UTILEABLE', 37: 'VTILEABLE', 38: 'XOFFSET', 39: 'YOFFSET',
  40: 'TEX_TILING_U', 41: 'TEX_TILING_V', 42: 'COLOR_FORMAT', 43: 'LIGHT0', 44: 'LIGHT1',
  45: 'LIGHT2', 46: 'LIGHT3', 47: 'RENDER_BORDER', 48: 'VERTEX_COLORS', 49: 'COLORS',
  50: 'FINDSQUADS_EXT', 51: 'FINDSTRIS_EXT', 53: 'DIFFUSE', 54: 'AMBIENT',
  55: 'SPECULAR', 56: 'EMISSION',
};

const MAT_STRING = new Set(['IMG_NAME', 'MAT_NAME', 'PNAME_IMD', 'TNAME_IMD']);
const MAT_BOOL = new Set(['FOG', 'BOTHFACE', 'NORMALORIENT', 'INCLUDE_IN_IMD',
  'LIGHT0', 'LIGHT1', 'LIGHT2', 'LIGHT3', 'RENDER_BORDER', 'VERTEX_COLORS']);
const MAT_BYTES = new Set(['DIFFUSE', 'AMBIENT', 'SPECULAR', 'EMISSION']);
const MAT_INT = new Set(['ALPHA', 'TEXGENMODE', 'TEX_TILING_U', 'TEX_TILING_V', 'COLOR_FORMAT']);
const TILE_INT = new Set(['WIDTH', 'HEIGHT']);
const TILE_BOOL = new Set(['XTILEABLE', 'YTILEABLE', 'UTILEABLE', 'VTILEABLE', 'GLOBALMAPPING']);
const TILE_FLOAT = new Set(['GLOBALTEXSCALE', 'XOFFSET', 'YOFFSET', 'ZOFFSET']);
const TILE_FLOATS = new Set(['VCOORDS', 'TCOORDS', 'NCOORDS', 'COLORS']);
const TILE_INTS = new Set(['TIDS', 'TOFFSETSQUAD', 'TOFFSETSTRI']);

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  get eof() { return this.p >= this.b.length; }
  u8() { return this.b[this.p++]; }
  i32() { const v = this.b.readInt32BE(this.p); this.p += 4; return v; }
  f32() { const v = this.b.readFloatBE(this.p); this.p += 4; return v; }
  ints(n) { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i32(); return a; }
  floats(n) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  string() { const n = this.i32(); const s = this.b.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  intEl() { this.i32(); return this.i32(); }
  boolEl() { this.i32(); return this.i32() === 1; }
  floatEl() { this.i32(); return this.f32(); }
  byteArr() { const n = this.i32(); const a = [...this.b.subarray(this.p, this.p + n)]; this.p += n; return a; }
  intArr() { const n = this.i32(); return Array.from(this.ints(n)); }
  floatArr() { const n = this.i32(); return this.floats(n); }
  intMatrix() { const n = this.i32(); const m = []; for (let i = 0; i < n; i++) m.push(Array.from(this.ints(this.i32()))); return m; }
  faces(nv, extended) {
    const n = this.i32(); const out = [];
    for (let i = 0; i < n; i++) {
      const v = this.ints(nv), t = this.ints(nv), nn = this.ints(nv);
      const c = extended ? this.ints(nv) : Int32Array.from({ length: nv }, () => 1);
      out.push({ v, t, n: nn, c });
    }
    return out;
  }
}

/** @returns {{materials:object[], tiles:object[], smartGrids:number[][][]}} */
export function parsePdsts(path) {
  const r = new Reader(readFileSync(path));
  const materials = [], tiles = [], smartGrids = [];
  let mat = null, tile = null;

  const flush = () => { if (tile) tiles.push(tile); };

  while (!r.eof) {
    const raw = r.u8();
    const tag = TAG[raw];
    if (tag === undefined) throw new Error(`${path}: unknown tag ${raw} at byte ${r.p - 1}`);

    if (tag === 'MAT_START') { r.intEl(); mat = {}; }
    else if (tag === 'MAT_END') { r.intEl(); materials.push(mat); mat = null; }
    else if (MAT_STRING.has(tag)) mat[tag] = r.string();
    else if (MAT_BOOL.has(tag)) mat[tag] = r.boolEl();
    else if (MAT_BYTES.has(tag)) mat[tag] = r.byteArr();
    else if (MAT_INT.has(tag)) mat[tag] = r.intEl();
    else if (tag === 'SMARTGRID') smartGrids.push(r.intMatrix());
    else if (tag === 'TILE') { r.intEl(); flush(); tile = { index: tiles.length }; }
    else if (TILE_INT.has(tag)) tile[tag] = r.intEl();
    else if (TILE_BOOL.has(tag)) tile[tag] = r.boolEl();
    else if (TILE_FLOAT.has(tag)) tile[tag] = r.floatEl();
    else if (TILE_FLOATS.has(tag)) tile[tag] = r.floatArr();
    else if (TILE_INTS.has(tag)) tile[tag] = r.intArr();
    else if (tag === 'FINDSQUADS') tile.quads = r.faces(4, false);
    else if (tag === 'FINDSTRIS') tile.tris = r.faces(3, false);
    else if (tag === 'FINDSQUADS_EXT') tile.quads = r.faces(4, true);
    else if (tag === 'FINDSTRIS_EXT') tile.tris = r.faces(3, true);
    else if (tag === 'OBJNAME') tile.OBJNAME = r.string();
    else throw new Error(`${path}: unhandled tag ${tag}`);
  }
  flush();

  for (const t of tiles) {
    t.quads ??= []; t.tris ??= [];
    t.VCOORDS ??= new Float32Array(0);
    t.TCOORDS ??= new Float32Array(0);
    t.NCOORDS ??= new Float32Array(0);
    // PDSMS defaults a colourless tile to a single white entry; faces index it 1-based.
    if (!t.COLORS || t.COLORS.length === 0) t.COLORS = Float32Array.of(1, 1, 1);
    t.TIDS ??= []; t.TOFFSETSQUAD ??= []; t.TOFFSETSTRI ??= [];
  }
  return { materials, tiles, smartGrids };
}

/**
 * Expands a tile's indexed OBJ data into triangles, grouped per texture slot, and
 * converted from PDSMS's Z-up / Y-south space into the engine's Y-up / Z-south space
 * (ARCHITECTURE §3.1). Each triangle's winding is aligned to the normals the tileset
 * author stored, so front faces are reliably counter-clockwise even though the source
 * tiles are not consistently wound.
 *
 * @returns {{groups: Array<{textureId:number, position:number[], uv:number[],
 *            normal:number[], color:number[]}>, bounds:{min:number[], max:number[]}}}
 */
export function tileToTriangles(tile) {
  const V = tile.VCOORDS, T = tile.TCOORDS, N = tile.NCOORDS, C = tile.COLORS;
  const nTex = Math.max(1, tile.TIDS.length);
  const groups = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

  /** One vertex, converted from PDSMS space (x east, y south, z up) to engine space. */
  const vertex = (vi, ti, ni, ci) => {
    const x = V[(vi - 1) * 3], ySouth = V[(vi - 1) * 3 + 1], zUp = V[(vi - 1) * 3 + 2];
    const nx = N[(ni - 1) * 3] ?? 0, nySouth = N[(ni - 1) * 3 + 1] ?? 0, nzUp = N[(ni - 1) * 3 + 2] ?? 1;
    return {
      p: [x, zUp, ySouth],
      // OBJ V points up, GL T points down.
      uv: [T[(ti - 1) * 2] ?? 0, -(T[(ti - 1) * 2 + 1] ?? 0)],
      n: [nx, nzUp, nySouth],
      c: [C[(ci - 1) * 3] ?? 1, C[(ci - 1) * 3 + 1] ?? 1, C[(ci - 1) * 3 + 2] ?? 1],
    };
  };

  /**
   * Emits one triangle with its winding aligned to its own normals.
   *
   * DS tileset authors do not keep a consistent winding — PDSMS renders with backface
   * culling off, so nothing forces them to. Mirroring y and z on import flips handedness on
   * top of that. Rather than guess a global flip, every triangle is checked against the
   * normal the artist stored and swapped when the two disagree; that makes single-sided
   * materials safe and, just as importantly, makes shadow casting correct, since three
   * renders shadows from the opposite face by default.
   */
  const emitTriangle = (g, a, b, c) => {
    const gx = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
    const hx = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
    const cross = [
      gx[1] * hx[2] - gx[2] * hx[1],
      gx[2] * hx[0] - gx[0] * hx[2],
      gx[0] * hx[1] - gx[1] * hx[0],
    ];
    const sn = [
      (a.n[0] + b.n[0] + c.n[0]) / 3,
      (a.n[1] + b.n[1] + c.n[1]) / 3,
      (a.n[2] + b.n[2] + c.n[2]) / 3,
    ];
    const dot = cross[0] * sn[0] + cross[1] * sn[1] + cross[2] * sn[2];
    const tri = dot < 0 ? [a, c, b] : [a, b, c];

    for (const v of tri) {
      g.position.push(v.p[0], v.p[1], v.p[2]);
      g.uv.push(v.uv[0], v.uv[1]);
      g.normal.push(v.n[0], v.n[1], v.n[2]);
      g.color.push(v.c[0], v.c[1], v.c[2]);
      if (v.p[0] < min[0]) min[0] = v.p[0]; if (v.p[0] > max[0]) max[0] = v.p[0];
      if (v.p[1] < min[1]) min[1] = v.p[1]; if (v.p[1] > max[1]) max[1] = v.p[1];
      if (v.p[2] < min[2]) min[2] = v.p[2]; if (v.p[2] > max[2]) max[2] = v.p[2];
    }
  };

  for (let k = 0; k < nTex; k++) {
    const g = { textureId: tile.TIDS[k] ?? 0, position: [], uv: [], normal: [], color: [] };

    const qStart = tile.TOFFSETSQUAD[k] ?? 0;
    const qEnd = k + 1 < nTex ? (tile.TOFFSETSQUAD[k + 1] ?? tile.quads.length) : tile.quads.length;
    for (let i = qStart; i < qEnd; i++) {
      const f = tile.quads[i];
      if (!f) continue;
      const v = [0, 1, 2, 3].map((j) => vertex(f.v[j], f.t[j], f.n[j], f.c[j]));
      emitTriangle(g, v[0], v[1], v[2]);
      emitTriangle(g, v[0], v[2], v[3]);
    }

    const tStart = tile.TOFFSETSTRI[k] ?? 0;
    const tEnd = k + 1 < nTex ? (tile.TOFFSETSTRI[k + 1] ?? tile.tris.length) : tile.tris.length;
    for (let i = tStart; i < tEnd; i++) {
      const f = tile.tris[i];
      if (!f) continue;
      const v = [0, 1, 2].map((j) => vertex(f.v[j], f.t[j], f.n[j], f.c[j]));
      emitTriangle(g, v[0], v[1], v[2]);
    }

    if (g.position.length) groups.push(g);
  }
  return { groups, bounds: { min, max } };
}
