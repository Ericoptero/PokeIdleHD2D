/**
 * Minimal OBJ + MTL reader, enough for the structures we author ourselves.
 *
 * Deliberately small: it handles v/vt/vn/f with negative and omitted indices, `usemtl`
 * grouping and n-gon fanning, and reads `map_Kd`/`d` out of the MTL. It does not handle
 * smoothing groups, materials libraries with relative paths outside the model folder, or
 * free-form geometry — none of which our own art uses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** @returns {Map<string, {map:string|null, alpha:number, doubleSided:boolean}>} */
export function parseMtl(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  let current = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    const value = rest.join(' ');
    if (key === 'newmtl') {
      current = { name: value, map: null, alpha: 1, doubleSided: false, emissive: 0 };
      out.set(value, current);
    } else if (!current) continue;
    else if (key === 'map_Kd') current.map = basename(value);
    else if (key === 'd') current.alpha = Number(value);
    else if (key === 'Tr') current.alpha = 1 - Number(value);
    else if (key === 'Ke') current.emissive = Math.max(...value.split(/\s+/).map(Number));
    else if (key === 'illum' && Number(value) === 2) current.doubleSided = false;
  }
  return out;
}

/**
 * @param {string} path
 * @param {{scale?:number, swapYZ?:boolean}} [opts] `swapYZ` converts a Z-up export
 *   (Blender's default) into the engine's Y-up space, matching ARCHITECTURE §3.1.
 * @returns {{objects: Array<{name:string, groups: Array<{material:string,
 *            position:number[], normal:number[], uv:number[], color:number[]}>}>,
 *           materials: Map<string, object>, bounds:{min:number[], max:number[]}}}
 */
export function parseObj(path, { scale = 1, swapYZ = false } = {}) {
  const text = readFileSync(path, 'utf8');
  const dir = dirname(path);
  const V = [], VT = [], VN = [];
  let materials = new Map();

  const objects = [];
  let object = null;
  let group = null;
  let material = 'default';
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];

  const startObject = (name) => {
    object = { name, groups: [] };
    objects.push(object);
    group = null;
  };
  const groupFor = (mat) => {
    if (!object) startObject(basename(path).replace(/\.obj$/i, ''));
    let g = object.groups.find((x) => x.material === mat);
    if (!g) { g = { material: mat, position: [], normal: [], uv: [], color: [] }; object.groups.push(g); }
    return g;
  };

  const idx = (raw, list) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) return -1;
    return n > 0 ? n - 1 : list.length + n;
  };

  const push = (g, vRaw, tRaw, nRaw) => {
    const vi = idx(vRaw, V);
    const p = V[vi] ?? [0, 0, 0];
    const x = p[0] * scale;
    const y = (swapYZ ? p[2] : p[1]) * scale;
    const z = (swapYZ ? p[1] : p[2]) * scale;
    g.position.push(x, y, z);
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;

    const ti = idx(tRaw, VT);
    const uv = VT[ti] ?? [0, 0];
    g.uv.push(uv[0], 1 - uv[1]);           // OBJ V is up, GL T is down

    const ni = idx(nRaw, VN);
    const nrm = VN[ni] ?? null;
    if (nrm) {
      g.normal.push(nrm[0], swapYZ ? nrm[2] : nrm[1], swapYZ ? nrm[1] : nrm[2]);
    } else {
      g.normal.push(0, 0, 0);              // filled in below from the face plane
    }
    g.color.push(1, 1, 1);
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const key = parts[0];

    if (key === 'v') V.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    else if (key === 'vt') VT.push([Number(parts[1]), Number(parts[2] ?? 0)]);
    else if (key === 'vn') VN.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    else if (key === 'o' || key === 'g') startObject(parts.slice(1).join(' ') || 'object');
    else if (key === 'usemtl') { material = parts[1] ?? 'default'; group = groupFor(material); }
    else if (key === 'mtllib') materials = new Map([...materials, ...parseMtl(join(dir, parts[1]))]);
    else if (key === 'f') {
      const g = group ?? (group = groupFor(material));
      const verts = parts.slice(1).map((v) => v.split('/'));
      // Fan the n-gon. Swapping Y and Z mirrors the model, which flips every triangle's
      // handedness, so the fan is reversed to keep winding consistent with the (equally
      // mirrored) normals — otherwise every upward-facing face renders backwards and a
      // roof looks like it has a hole in it.
      for (let i = 1; i + 1 < verts.length; i++) {
        const tri = swapYZ ? [verts[0], verts[i + 1], verts[i]] : [verts[0], verts[i], verts[i + 1]];
        for (const v of tri) push(g, v[0], v[1], v[2]);
      }
    }
  }

  // Fill any missing normals from the face plane so flat-shaded exports still light.
  for (const o of objects) {
    for (const g of o.groups) {
      for (let i = 0; i < g.position.length; i += 9) {
        if (g.normal[i] !== 0 || g.normal[i + 1] !== 0 || g.normal[i + 2] !== 0) continue;
        const a = g.position.slice(i, i + 3);
        const b = g.position.slice(i + 3, i + 6);
        const c = g.position.slice(i + 6, i + 9);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const len = Math.hypot(...n) || 1;
        for (let k = 0; k < 3; k++) {
          g.normal[i + k * 3] = n[0] / len;
          g.normal[i + k * 3 + 1] = n[1] / len;
          g.normal[i + k * 3 + 2] = n[2] / len;
        }
      }
    }
  }

  return { objects, materials, bounds: { min, max } };
}
