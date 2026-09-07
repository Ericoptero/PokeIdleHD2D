/**
 * The instanced world (ARCHITECTURE §7).
 *
 * Placements are grouped by (model, material group) and each group becomes one
 * InstancedMesh. A 96x96 map lands at roughly 110–200 draw calls with every tile resident,
 * which is why we do not chunk: chunking would multiply draw calls by the chunk count for
 * a culling win we do not need at this world size.
 */

import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const _axisY = new THREE.Vector3(0, 1, 0);

/**
 * Reproduces PDSMS's global texture mapping on an InstancedMesh: the geometry carries the
 * UVs for one cell and each instance shifts them by its own cell position, so a field of
 * grass shows a 1/scale-cell repeat instead of the same stamp in every square.
 *
 * The material is cloned before patching — several models share one material object, and
 * only the global-mapped ones may grow this attribute.
 */
function attachGlobalUv(mesh, items, scale) {
  const offsets = new Float32Array(items.length * 2);
  for (let i = 0; i < items.length; i++) {
    offsets[i * 2] = items[i].cx * scale;
    offsets[i * 2 + 1] = items[i].cz * scale;
  }
  mesh.geometry = mesh.geometry.clone();
  mesh.geometry.setAttribute('aUvOffset', new THREE.InstancedBufferAttribute(offsets, 2));

  const mat = mesh.material.clone();
  mat.name = `${mesh.material.name}+globalUv`;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOffset;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvMapUv += aUvOffset;');
  };
  mat.customProgramCacheKey = () => 'globalUv';
  mesh.material = mat;
  mesh.userData.globalUv = true;
}

/**
 * @typedef {Object} Placement
 * @property {number} modelId  tile model id within the tileset
 * @property {number} cx       cell x (west→east)
 * @property {number} cz       cell z (north→south)
 * @property {number} [y]      world Y of the tile's own origin; defaults to 0
 * @property {0|1|2|3} [rot]   quarter turns about +Y, applied about the footprint centre
 * @property {number} [tint]   0xRRGGBB multiplied into the instance; defaults to white
 */

export class InstancedWorld {
  /**
   * @param {typeof THREE} T
   * @param {THREE.Object3D} parent
   * @param {object} tileset  the loaded tileset from tiles/index.js
   * @param {Placement[]} placements
   */
  constructor(T, parent, tileset, placements, { name = 'world', castShadow = true, receiveShadow = true } = {}) {
    this.tileset = tileset;
    this.group = new THREE.Group();
    this.group.name = name;
    this.meshes = [];
    this.placements = placements;
    this.stats = { placements: placements.length, meshes: 0, triangles: 0, skipped: 0 };

    /** @type {Map<string, {model:object, groupIndex:number, items:Placement[]}>} */
    const buckets = new Map();
    for (const p of placements) {
      const model = tileset.byId.get(p.modelId);
      if (!model) { this.stats.skipped++; continue; }
      for (let gi = 0; gi < model.groups.length; gi++) {
        const key = `${p.modelId}:${gi}`;
        let b = buckets.get(key);
        if (!b) buckets.set(key, (b = { model, groupIndex: gi, items: [] }));
        b.items.push(p);
      }
    }

    for (const { model, groupIndex, items } of buckets.values()) {
      const g = model.groups[groupIndex];
      const mesh = new THREE.InstancedMesh(g.geometry, g.material, items.length);
      mesh.name = `${model.name}#${groupIndex}`;
      mesh.castShadow = castShadow && !model.tags.includes('flat');
      mesh.receiveShadow = receiveShadow;
      mesh.frustumCulled = false;      // one mesh spans the whole map; culling it is all-or-nothing
      mesh.userData.model = model;

      let needsColor = false;
      for (let i = 0; i < items.length; i++) {
        const p = items[i];
        this.constructor.composeMatrix(_m, p, model);
        mesh.setMatrixAt(i, _m);
        if (p.tint !== undefined && p.tint !== 0xffffff) needsColor = true;
      }

      if (model.globalUv && model.uvScale) {
        attachGlobalUv(mesh, items, model.uvScale);
      }
      if (needsColor) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(items.length * 3), 3);
        for (let i = 0; i < items.length; i++) {
          _c.set(items[i].tint ?? 0xffffff);
          mesh.setColorAt(i, _c);
        }
        mesh.instanceColor.needsUpdate = true;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();

      this.group.add(mesh);
      this.meshes.push({ mesh, model, groupIndex, items });
      this.stats.triangles += (g.count / 3) * items.length;
    }
    this.stats.meshes = this.meshes.length;
    parent.add(this.group);
  }

  /**
   * Tile geometry is authored with its origin at the footprint's north-west corner, so a
   * rotation has to happen about the footprint centre to keep the tile on its cells.
   */
  static composeMatrix(out, p, model) {
    const rot = (p.rot ?? 0) & 3;
    const w = model.w ?? 1, h = model.h ?? 1;
    _q.setFromAxisAngle(_axisY, -rot * Math.PI * 0.5);
    if (rot === 0) {
      _p.set(p.cx, p.y ?? 0, p.cz);
    } else {
      // Rotate the local footprint about its centre, then place that centre on the cells.
      const halfW = w / 2, halfH = h / 2;
      const cxCentre = p.cx + ((rot & 1) ? halfH : halfW);
      const czCentre = p.cz + ((rot & 1) ? halfW : halfH);
      const dx = -halfW, dz = -halfH;
      const cos = Math.cos(-rot * Math.PI * 0.5), sin = Math.sin(-rot * Math.PI * 0.5);
      _p.set(cxCentre + (dx * cos + dz * sin), p.y ?? 0, czCentre + (-dx * sin + dz * cos));
    }
    out.compose(_p, _q, _s);
    return out;
  }

  /** Re-tints one placement (season, night dimming, damage flash). */
  setTint(placementIndex, hex) {
    const p = this.placements[placementIndex];
    if (!p) return;
    p.tint = hex;
    for (const entry of this.meshes) {
      const i = entry.items.indexOf(p);
      if (i < 0) continue;
      if (!entry.mesh.instanceColor) {
        entry.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(entry.items.length * 3).fill(1), 3);
      }
      _c.set(hex);
      entry.mesh.setColorAt(i, _c);
      entry.mesh.instanceColor.needsUpdate = true;
    }
  }

  setVisible(v) { this.group.visible = v; }

  dispose() {
    for (const { mesh } of this.meshes) {
      mesh.dispose();
      mesh.removeFromParent();
    }
    this.meshes.length = 0;
    this.group.removeFromParent();
  }
}
