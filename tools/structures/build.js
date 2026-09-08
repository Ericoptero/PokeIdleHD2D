#!/usr/bin/env node
/**
 * Models the buildings the city needs (DECISIONS #3, #12) and writes them as OBJ + MTL +
 * meta.json into assets/structures/, ready for tools/assets/build-structures.js.
 *
 * Generated rather than sculpted, because the shapes are the shapes: a Black & White 2 town
 * building is a plinth, a wall box, a hipped roof with an overhang, and a fascia. What makes
 * one read as a Pokemon Center and not as a grey box is the roof colour, the awning, the
 * Poke Ball sign, the glass doors and the lit windows — all of which are textures, and all
 * of which are authored in tools/structures/textures.js.
 *
 * Everything is built in Blender's axis convention (X east, Y south, Z up) and flipped to
 * the engine's Y-up on import, so these files also open correctly in Blender for hand
 * editing later.
 *
 * UVs are laid out at a fixed 32 texels per world unit so a wall sits on the same pixel
 * grid as the grass it stands on.
 *
 *   node tools/structures/build.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const OUT = join(REPO, 'assets', 'structures');

const TEXELS_PER_UNIT = 32;

/**
 * Where the daytime pane sits on window.png. The sheet packs the day pane in the image's TOP
 * half and the lit interior below it, so a night material only has to shift V by half a
 * sheet instead of loading a second texture. V is emitted flipped (see the OBJ writer), so
 * the image's top half is the *upper* half of the V range, not v 0..0.5 — getting this wrong
 * put every window on the night pane in broad daylight.
 */
const DAY_PANE = 0.5;

class Mesh {
  constructor() { this.v = []; this.vt = []; this.vn = []; this.faces = []; }

  vertex(p, uv, n) {
    this.v.push(p); this.vt.push(uv); this.vn.push(n);
    return this.v.length;                       // OBJ indices are 1-based
  }

  /**
   * A planar quad from four corners, with an explicit UV rect.
   *
   * `expect` is the direction the face should point. Getting corner order right by hand
   * across six box faces, four roof slopes and a cap is exactly the kind of bookkeeping that
   * produces one silently backfacing polygon, so the order is checked against `expect` and
   * reversed when it disagrees. The normal is then taken from the same winding the renderer
   * will triangulate, so the two can never drift apart.
   *
   * @param {number[][]} corners four [x,y,z] in Blender space (X east, Y south, Z up)
   * @param {string} material
   * @param {{u0?:number,v0?:number,u1?:number,v1?:number,expect?:number[]}} [uv]
   */
  quad(corners, material, uv = {}) {
    const { u0 = 0, v0 = 0, u1 = 1, v1 = 1, expect = null } = uv;
    let pts = corners;

    const normalOf = ([a, b, c]) => {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const len = Math.hypot(...n) || 1;
      return [n[0] / len, n[1] / len, n[2] / len];
    };

    let nn = normalOf(pts);
    if (expect) {
      const dot = nn[0] * expect[0] + nn[1] * expect[1] + nn[2] * expect[2];
      if (dot < 0) { pts = [pts[0], pts[3], pts[2], pts[1]]; nn = normalOf(pts); }
    }
    const uvs = expect && pts !== corners
      ? [[u0, v0], [u0, v1], [u1, v1], [u1, v0]]
      : [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const idx = pts.map((p, i) => this.vertex(p, uvs[i], nn));
    this.faces.push({ material, idx });
    return this;
  }

  /**
   * An axis-aligned box. `skip` names faces to omit (they would be hidden anyway, and every
   * hidden face is a triangle the GPU draws for nothing at 60 Hz).
   * UVs run at TEXELS_PER_UNIT against the given texture size, so the pattern is continuous
   * across faces of different sizes.
   */
  box(x0, y0, z0, x1, y1, z1, material, texW, texH, { skip = [], uvOffset = [0, 0] } = {}) {
    const su = TEXELS_PER_UNIT / texW, sv = TEXELS_PER_UNIT / texH;
    const [ou, ov] = uvOffset;
    const w = x1 - x0, d = y1 - y0, h = z1 - z0;
    const U = (n) => ou + n * su, V = (n) => ov + n * sv;

    // north face looks toward -Y, south toward +Y
    if (!skip.includes('south')) this.quad(
      [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], material,
      { u0: U(0), v0: V(0), u1: U(w), v1: V(h), expect: [0, 1, 0] });
    if (!skip.includes('north')) this.quad(
      [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]], material,
      { u0: U(0), v0: V(0), u1: U(w), v1: V(h), expect: [0, -1, 0] });
    if (!skip.includes('east')) this.quad(
      [[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1]], material,
      { u0: U(0), v0: V(0), u1: U(d), v1: V(h), expect: [1, 0, 0] });
    if (!skip.includes('west')) this.quad(
      [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], material,
      { u0: U(0), v0: V(0), u1: U(d), v1: V(h), expect: [-1, 0, 0] });
    if (!skip.includes('top')) this.quad(
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], material,
      { u0: U(0), v0: V(0), u1: U(w), v1: V(d), expect: [0, 0, 1] });
    if (!skip.includes('bottom')) this.quad(
      [[x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]], material,
      { u0: U(0), v0: V(0), u1: U(w), v1: V(d), expect: [0, 0, -1] });
    return this;
  }

  /**
   * A hipped roof: four sloping faces from a rectangular eave to a smaller ridge rectangle,
   * plus the flat cap between them. This silhouette is what makes a DS-era town building
   * read as a building rather than as a crate.
   */
  hipRoof(x0, y0, x1, y1, z0, z1, inset, material, texW, texH) {
    const su = TEXELS_PER_UNIT / texW, sv = TEXELS_PER_UNIT / texH;
    const rx0 = x0 + inset, rx1 = x1 - inset, ry0 = y0 + inset, ry1 = y1 - inset;
    const run = inset, rise = z1 - z0;
    const slope = Math.hypot(run, rise);

    const face = (a, b, c, d, width, expect) => this.quad([a, b, c, d], material,
      { u0: 0, v0: 0, u1: width * su, v1: slope * sv, expect });

    // Each slope leans outward and up, so its normal is the horizontal outward direction
    // scaled by the run plus Z scaled by the rise.
    const s2 = 1 / (Math.hypot(run, rise) || 1);
    face([x0, y1, z0], [x1, y1, z0], [rx1, ry1, z1], [rx0, ry1, z1], x1 - x0, [0, run * s2, rise * s2]);
    face([x1, y0, z0], [x0, y0, z0], [rx0, ry0, z1], [rx1, ry0, z1], x1 - x0, [0, -run * s2, rise * s2]);
    face([x1, y1, z0], [x1, y0, z0], [rx1, ry0, z1], [rx1, ry1, z1], y1 - y0, [run * s2, 0, rise * s2]);
    face([x0, y0, z0], [x0, y1, z0], [rx0, ry1, z1], [rx0, ry0, z1], y1 - y0, [-run * s2, 0, rise * s2]);

    this.quad([[rx0, ry0, z1], [rx1, ry0, z1], [rx1, ry1, z1], [rx0, ry1, z1]], material,
      { u0: 0, v0: 0, u1: (rx1 - rx0) * su, v1: (ry1 - ry0) * sv, expect: [0, 0, 1] });
    return this;
  }

  /** A sloped awning slab projecting from a wall, with a thin underside. */
  awning(x0, x1, yWall, project, zHigh, zLow, material, texW, texH) {
    const su = TEXELS_PER_UNIT / texW, sv = TEXELS_PER_UNIT / texH;
    const yOut = yWall + project;
    const w = x1 - x0, slope = Math.hypot(project, zHigh - zLow);
    const drop = zHigh - zLow, s2 = 1 / (Math.hypot(project, drop) || 1);
    // top surface: leans out and up
    this.quad([[x0, yWall, zHigh], [x1, yWall, zHigh], [x1, yOut, zLow], [x0, yOut, zLow]],
      material, { u0: 0, v0: 0, u1: w * su, v1: slope * sv, expect: [0, drop * s2, project * s2] });
    // underside, drawn dark by the same texture's bottom rows
    this.quad([[x0, yOut, zLow - 0.06], [x1, yOut, zLow - 0.06], [x1, yWall, zHigh - 0.06], [x0, yWall, zHigh - 0.06]],
      material, { u0: 0, v0: 0.9 * sv, u1: w * su, v1: sv, expect: [0, -drop * s2, -project * s2] });
    // front lip
    this.quad([[x0, yOut, zLow - 0.06], [x0, yOut, zLow], [x1, yOut, zLow], [x1, yOut, zLow - 0.06]],
      material, { u0: 0, v0: 0.85 * sv, u1: w * su, v1: sv, expect: [0, 1, 0] });
    return this;
  }

  toObj(name, materials) {
    const out = [`# ${name}`, `# generated by tools/structures/build.js — edit that, not this`,
      `mtllib ${name}.mtl`, `o ${name}`];
    for (const p of this.v) out.push(`v ${p.map((n) => n.toFixed(4)).join(' ')}`);
    // V is emitted upside down on purpose. The Canvas in pixel.js draws in image space with
    // row 0 at the top, tools/assets/obj.js flips V on import ("OBJ V is up, GL T is down"),
    // and three then samples a flipY texture from the bottom — an odd number of flips, so a
    // texture that is not vertically symmetric arrives upside down. It shipped that way: the
    // Poke Ball on the roof of both the Centre and the Mart had its white half on top, which
    // is the kind of thing every player of these games sees instantly. Emitting 1-v here
    // makes the count even, and what is drawn is what is rendered.
    for (const t of this.vt) out.push(`vt ${t[0].toFixed(5)} ${(1 - t[1]).toFixed(5)}`);
    for (const n of this.vn) out.push(`vn ${n.map((x) => x.toFixed(4)).join(' ')}`);
    let current = null;
    for (const f of this.faces) {
      if (f.material !== current) { out.push(`usemtl ${f.material}`); current = f.material; }
      out.push(`f ${f.idx.map((i) => `${i}/${i}/${i}`).join(' ')}`);
    }
    return out.join('\n') + '\n';
  }
}

function writeMtl(name, materials) {
  const out = [`# ${name}`];
  for (const [mat, spec] of Object.entries(materials)) {
    out.push(`newmtl ${mat}`, 'Ka 1.000 1.000 1.000', 'Kd 1.000 1.000 1.000', 'Ks 0.000 0.000 0.000',
      `d ${(spec.alpha ?? 1).toFixed(3)}`, `Ke ${(spec.emissive ?? 0).toFixed(3)} 0 0`,
      'illum 1', `map_Kd ${spec.map}`, '');
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The buildings
// ---------------------------------------------------------------------------

/**
 * Pokemon Center. 8 cells wide, 6 deep. The entrance is on the south face because the camera
 * looks north-ish down onto the world, so the front of a building has to face +Z / +Y.
 */
function pokemonCenter() {
  const m = new Mesh();
  const W = 8, D = 6;
  const PLINTH = 0.3, WALL_TOP = 3.0, EAVE = 2.9, RIDGE = 4.5, OVERHANG = 0.45;

  m.box(0, 0, 0, W, D, PLINTH, 'plinth', 32, 32, { skip: ['bottom'] });
  m.box(0.1, 0.1, PLINTH, W - 0.1, D - 0.1, WALL_TOP, 'wall', 64, 64, { skip: ['bottom', 'top'] });
  m.box(-OVERHANG, -OVERHANG, EAVE - 0.22, W + OVERHANG, D + OVERHANG, EAVE, 'timber', 32, 32, { skip: ['bottom'] });
  m.hipRoof(-OVERHANG, -OVERHANG, W + OVERHANG, D + OVERHANG, EAVE, RIDGE, 2.6, 'roof', 64, 64);

  const front = D - 0.09;    // a hair proud of the wall so nothing z-fights
  // sliding glass doors, 2 wide x 2.2 tall, centred
  const dx = W / 2 - 1;
  m.quad([[dx, front, PLINTH], [dx + 2, front, PLINTH], [dx + 2, front, PLINTH + 2.2], [dx, front, PLINTH + 2.2]],
    'door', { u0: 0, v0: 0, u1: 1, v1: 1, expect: [0, 1, 0] });
  // door frame
  m.box(dx - 0.16, D - 0.14, PLINTH, dx, D - 0.04, PLINTH + 2.36, 'timber', 32, 32, { skip: ['north'] });
  m.box(dx + 2, D - 0.14, PLINTH, dx + 2.16, D - 0.04, PLINTH + 2.36, 'timber', 32, 32, { skip: ['north'] });
  m.box(dx - 0.16, D - 0.14, PLINTH + 2.2, dx + 2.16, D - 0.04, PLINTH + 2.36, 'timber', 32, 32, { skip: ['north'] });

  m.awning(dx - 0.6, dx + 2.6, D - 0.05, 1.1, PLINTH + 2.5, PLINTH + 2.15, 'awning', 64, 32);

  // the sign, sitting on the front roof slope where BW2 puts it
  const signW = 2.4, signH = 1.2;
  const t = 0.42;                                   // how far up the slope
  const yA = D + OVERHANG, zA = EAVE;
  const yB = D + OVERHANG - 2.6, zB = RIDGE;
  const y0 = yA + (yB - yA) * (t - 0.14), z0 = zA + (zB - zA) * (t - 0.14);
  const y1 = yA + (yB - yA) * (t + 0.36), z1 = zA + (zB - zA) * (t + 0.36);
  const sx = W / 2 - signW / 2;
  m.quad([[sx, y0 + 0.05, z0 + 0.04], [sx + signW, y0 + 0.05, z0 + 0.04],
    [sx + signW, y1 + 0.05, z1 + 0.04], [sx, y1 + 0.05, z1 + 0.04]], 'sign',
    { expect: [0, 0.62, 0.78] });

  // windows: two on the front either side of the door, two per side wall
  const win = (x, y, z, w, h, axis) => {
    if (axis === 'y') {
      m.quad([[x, y, z], [x + w, y, z], [x + w, y, z + h], [x, y, z + h]], 'window',
        { u0: 0, v0: DAY_PANE, v1: DAY_PANE + 0.5, u1: 1, expect: [0, 1, 0] });
    } else {
      // side walls: the pane faces whichever way it is offset from the building centre
      m.quad([[x, y, z], [x, y + w, z], [x, y + w, z + h], [x, y, z + h]], 'window',
        { u0: 0, v0: DAY_PANE, v1: DAY_PANE + 0.5, u1: 1, expect: [x > 1 ? 1 : -1, 0, 0] });
    }
  };
  win(0.7, front, PLINTH + 0.9, 1.6, 1.5, 'y');
  win(W - 2.3, front, PLINTH + 0.9, 1.6, 1.5, 'y');
  win(W - 0.07, 1.0, PLINTH + 0.9, 1.6, 1.5, 'x');
  win(W - 0.07, 3.2, PLINTH + 0.9, 1.6, 1.5, 'x');
  win(0.07, 1.0, PLINTH + 0.9, 1.6, 1.5, 'x');
  win(0.07, 3.2, PLINTH + 0.9, 1.6, 1.5, 'x');

  return {
    mesh: m,
    materials: {
      plinth: { map: 'plinth.png' }, wall: { map: 'wall.png' }, timber: { map: 'timber.png' },
      roof: { map: 'roof.png' }, door: { map: 'door.png', emissive: 0.35 },
      awning: { map: 'awning.png' }, sign: { map: 'sign.png' },
      window: { map: 'window.png', emissive: 0.5 },
    },
    meta: {
      category: 'building', subcategory: 'pokemon_center',
      tags: ['building', 'landmark', 'pokecenter', 'heal'],
      biomes: ['city'], collision: 'block', w: W, h: D,
      door: [W / 2 - 1, D - 1], swapYZ: true,
      emissiveMaterials: ['window', 'door'],
    },
  };
}

/** Poke Mart. 6 x 5, blue roof, a wide shop window and a single door. */
function pokeMart() {
  const m = new Mesh();
  const W = 6, D = 5;
  const PLINTH = 0.3, WALL_TOP = 2.8, EAVE = 2.7, RIDGE = 3.9, OVERHANG = 0.4;

  m.box(0, 0, 0, W, D, PLINTH, 'plinth', 32, 32, { skip: ['bottom'] });
  m.box(0.1, 0.1, PLINTH, W - 0.1, D - 0.1, WALL_TOP, 'wall', 64, 64, { skip: ['bottom', 'top'] });
  m.box(-OVERHANG, -OVERHANG, EAVE - 0.2, W + OVERHANG, D + OVERHANG, EAVE, 'timber', 32, 32, { skip: ['bottom'] });
  m.hipRoof(-OVERHANG, -OVERHANG, W + OVERHANG, D + OVERHANG, EAVE, RIDGE, 2.1, 'roof', 64, 64);

  const front = D - 0.09;
  const dx = W - 2.4;
  m.quad([[dx, front, PLINTH], [dx + 1.6, front, PLINTH], [dx + 1.6, front, PLINTH + 2.1], [dx, front, PLINTH + 2.1]],
    'door', { u0: 0.1, v0: 0, u1: 0.9, v1: 1, expect: [0, 1, 0] });
  m.box(dx - 0.14, D - 0.14, PLINTH, dx, D - 0.04, PLINTH + 2.24, 'timber', 32, 32, { skip: ['north'] });
  m.box(dx + 1.6, D - 0.14, PLINTH, dx + 1.74, D - 0.04, PLINTH + 2.24, 'timber', 32, 32, { skip: ['north'] });

  // a wide shop window, the thing that says "shop" at a glance
  m.quad([[0.6, front, PLINTH + 0.6], [3.2, front, PLINTH + 0.6],
    [3.2, front, PLINTH + 2.1], [0.6, front, PLINTH + 2.1]], 'window',
    { u0: 0, v0: DAY_PANE, v1: DAY_PANE + 0.5, u1: 1.6, expect: [0, 1, 0] });
  m.awning(0.4, 3.4, D - 0.05, 0.9, PLINTH + 2.35, PLINTH + 2.05, 'awning', 64, 32);

  const signW = 2.2, signH = 1.0;
  const yA = D + OVERHANG, zA = EAVE, yB = D + OVERHANG - 2.1, zB = RIDGE;
  const t0 = 0.3, t1 = 0.78;
  const sx = W / 2 - signW / 2;
  m.quad([[sx, yA + (yB - yA) * t0 + 0.05, zA + (zB - zA) * t0 + 0.04],
    [sx + signW, yA + (yB - yA) * t0 + 0.05, zA + (zB - zA) * t0 + 0.04],
    [sx + signW, yA + (yB - yA) * t1 + 0.05, zA + (zB - zA) * t1 + 0.04],
    [sx, yA + (yB - yA) * t1 + 0.05, zA + (zB - zA) * t1 + 0.04]], 'sign',
    { expect: [0, 0.62, 0.78] });

  for (const y of [1.0, 3.0]) {
    m.quad([[W - 0.07, y, PLINTH + 0.9], [W - 0.07, y + 1.5, PLINTH + 0.9],
      [W - 0.07, y + 1.5, PLINTH + 2.3], [W - 0.07, y, PLINTH + 2.3]], 'window',
      { u0: 0, v0: 0, u1: 1, v1: 0.5, expect: [1, 0, 0] });
    m.quad([[0.07, y + 1.5, PLINTH + 0.9], [0.07, y, PLINTH + 0.9],
      [0.07, y, PLINTH + 2.3], [0.07, y + 1.5, PLINTH + 2.3]], 'window',
      { u0: 0, v0: 0, u1: 1, v1: 0.5, expect: [-1, 0, 0] });
  }

  return {
    mesh: m,
    materials: {
      plinth: { map: 'plinth.png' }, wall: { map: 'wall.png' }, timber: { map: 'timber.png' },
      roof: { map: 'roof.png' }, door: { map: 'door.png', emissive: 0.3 },
      awning: { map: 'awning.png' }, sign: { map: 'sign.png' },
      window: { map: 'window.png', emissive: 0.5 },
    },
    meta: {
      category: 'building', subcategory: 'poke_mart',
      tags: ['building', 'landmark', 'mart', 'shop'],
      biomes: ['city'], collision: 'block', w: W, h: D,
      door: [W - 2.4, D - 1], swapYZ: true,
      emissiveMaterials: ['window', 'door'],
    },
  };
}

/** A townhouse, 5 x 4, used to fill out the streets. */
function houseA() {
  const m = new Mesh();
  const W = 5, D = 4;
  const PLINTH = 0.25, WALL_TOP = 2.5, EAVE = 2.4, RIDGE = 3.6, OVERHANG = 0.35;

  m.box(0, 0, 0, W, D, PLINTH, 'plinth', 32, 32, { skip: ['bottom'] });
  m.box(0.1, 0.1, PLINTH, W - 0.1, D - 0.1, WALL_TOP, 'wall', 64, 64, { skip: ['bottom', 'top'] });
  m.box(-OVERHANG, -OVERHANG, EAVE - 0.18, W + OVERHANG, D + OVERHANG, EAVE, 'timber', 32, 32, { skip: ['bottom'] });
  m.hipRoof(-OVERHANG, -OVERHANG, W + OVERHANG, D + OVERHANG, EAVE, RIDGE, 1.7, 'roof', 64, 64);

  const front = D - 0.09;
  const dx = W / 2 - 0.6;
  m.quad([[dx, front, PLINTH], [dx + 1.2, front, PLINTH], [dx + 1.2, front, PLINTH + 2.0], [dx, front, PLINTH + 2.0]],
    'door', { u0: 0, v0: 0, u1: 1, v1: 1, expect: [0, 1, 0] });
  m.box(dx - 0.12, D - 0.14, PLINTH, dx, D - 0.04, PLINTH + 2.12, 'timber', 32, 32, { skip: ['north'] });
  m.box(dx + 1.2, D - 0.14, PLINTH, dx + 1.32, D - 0.04, PLINTH + 2.12, 'timber', 32, 32, { skip: ['north'] });

  for (const x of [0.5, W - 1.7]) {
    m.quad([[x, front, PLINTH + 0.8], [x + 1.2, front, PLINTH + 0.8],
      [x + 1.2, front, PLINTH + 2.0], [x, front, PLINTH + 2.0]], 'window',
      { u0: 0, v0: DAY_PANE, v1: DAY_PANE + 0.5, u1: 1, expect: [0, 1, 0] });
  }
  m.quad([[W - 0.07, 1.0, PLINTH + 0.8], [W - 0.07, 2.4, PLINTH + 0.8],
    [W - 0.07, 2.4, PLINTH + 2.0], [W - 0.07, 1.0, PLINTH + 2.0]], 'window',
    { u0: 0, v0: 0, u1: 1, v1: 0.5, expect: [1, 0, 0] });
  m.quad([[0.07, 2.4, PLINTH + 0.8], [0.07, 1.0, PLINTH + 0.8],
    [0.07, 1.0, PLINTH + 2.0], [0.07, 2.4, PLINTH + 2.0]], 'window',
    { u0: 0, v0: 0, u1: 1, v1: 0.5, expect: [-1, 0, 0] });

  return {
    mesh: m,
    materials: {
      plinth: { map: 'plinth.png' }, wall: { map: 'wall.png' }, timber: { map: 'timber.png' },
      roof: { map: 'roof.png' }, door: { map: 'door.png' }, window: { map: 'window.png', emissive: 0.5 },
    },
    meta: {
      category: 'building', subcategory: 'house',
      tags: ['building', 'house'], biomes: ['city'], collision: 'block',
      w: W, h: D, door: [W / 2 - 0.6, D - 1], swapYZ: true,
      emissiveMaterials: ['window'],
    },
  };
}

const BUILDINGS = { pokemon_center: pokemonCenter, poke_mart: pokeMart, house_a: houseA };

for (const [name, make] of Object.entries(BUILDINGS)) {
  const { mesh, materials, meta } = make();
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.obj`), mesh.toObj(name, materials));
  writeFileSync(join(dir, `${name}.mtl`), writeMtl(name, materials));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  const tris = mesh.faces.reduce((a, f) => a + (f.idx.length - 2), 0);
  console.log(`✓ ${name.padEnd(16)} ${meta.w}x${meta.h}  ${mesh.v.length} verts  ${tris} tris  ` +
    `${Object.keys(materials).length} materials`);
}
