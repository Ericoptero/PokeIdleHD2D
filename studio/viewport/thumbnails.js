/**
 * viewport/thumbnails.js — offscreen 3D previews for the asset library, built on the exact same
 * `tiles`/`InstancedWorld` pipeline the real 3D pane renders with (`ctx.get('tiles')` — the same
 * loaded tileset instance `viewport/index.js` already booted, reached through it rather than a
 * second `@/tiles/index.js` import for the same reason `camera.js`'s own header gives: a second
 * import risks a second, un-loaded `tiles` instance existing). A card built from this really shows
 * how the tile will look once placed — the real geometry, the real per-material shader, the real
 * autotile-resolved mesh for a set piece — not a guess at its "dominant" 2D texture stretched flat.
 *
 * Lighting is a small, fixed hemi+directional rig, never the full `environment` module: that
 * module is stateful and animated (day-night ramp, weather, lamp emissive), which is the wrong
 * thing for a one-shot or idle preview scene to depend on. "Same projection and geometry, a
 * simpler neutral light" is the deliberate tradeoff here, not an oversight.
 *
 * Two callers share the technique (`makeSceneRig`/`frameOn`), each owning its own renderer:
 *  - `renderThumbnail(tileset, model)` — one-shot, cached by `${tileset}:${model.name}`: builds a
 *    throwaway single-placement `InstancedWorld`, frames the camera on the model's own `bounds`,
 *    renders one frame, reads back a PNG data URL, disposes the world (never the shared tileset
 *    geometry/material `InstancedWorld.dispose()` deliberately leaves alone — see its own header).
 *  - `mountLiveModelView(container)` — persistent: one canvas mounted into `container`, orbit-
 *    draggable via `setModel(tileset, model)`. Re-renders only on drag; nothing in this scene
 *    animates on its own, so no idle `requestAnimationFrame` loop is needed.
 */
import * as THREE from 'three';

const THUMB_SIZE = 160; // rendered once at this resolution; a grid card is far smaller on screen
const PITCH_DEG = 45; // matches `config.cameraPitch` (`src/core/config.js`) — the real editor's fixed pitch
const FRAME_PAD = 1.25; // headroom so a model's silhouette never touches the frame edge

function makeSceneRig() {
  const scene = new THREE.Scene();
  // A soft sky/ground fill plus one directional key, roughly the game's own default daylight
  // angle (`makeSunShadow`'s `dir = (0.5, 1, 0.3)`, `src/core/render.js`) — no shadow map, this
  // is a small throwaway scene with nothing to receive a shadow anyway.
  const hemi = new THREE.HemisphereLight(0xfff3df, 0x2a2118, 1.15);
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.position.set(0.5, 1, 0.3);
  scene.add(hemi, sun);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
  return { scene, camera };
}

/** Positions `camera` at the fixed pitch, orbited `yaw` radians around `model`'s own AABB center
 *  (`model.bounds` — already world-space, baked baseY included), then tightens the orthographic
 *  frustum to the model's exact projected extent (all 8 AABB corners, not just its footprint) so
 *  a tall prop or a raised cliff-top tile is framed correctly too, not just a flat 1x1 ground
 *  tile. Cheap enough to call before every render — no caching of the frustum itself. */
function frameOn(camera, model, yaw = 0) {
  const b = model?.bounds ?? { min: [0, 0, 0], max: [model?.w ?? 1, 1, model?.h ?? 1] };
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  const cz = (b.min[2] + b.max[2]) / 2;
  const pitchRad = THREE.MathUtils.degToRad(PITCH_DEG);
  const dist = 20;
  const horiz = Math.cos(pitchRad) * dist;
  camera.position.set(cx + Math.sin(yaw) * horiz, cy + Math.sin(pitchRad) * dist, cz + Math.cos(yaw) * horiz);
  camera.lookAt(cx, cy, cz);
  camera.updateMatrixWorld(true);

  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  const v = new THREE.Vector3();
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) {
        v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
    }
  }
  const halfW = Math.max(0.35, ((maxX - minX) / 2) * FRAME_PAD);
  const halfH = Math.max(0.35, ((maxY - minY) / 2) * FRAME_PAD);
  camera.left = -halfW; camera.right = halfW; camera.top = halfH; camera.bottom = -halfH;
  camera.near = 0.05; camera.far = dist * 3;
  camera.updateProjectionMatrix();
}

/** @param {{get:(id:string) => object}} ctx the viewport's own mini-registry (`viewport/index.js`) */
export function makeThumbnailer({ ctx }) {
  const cache = new Map(); // `${tileset}:${model.name}` -> data URL, or an in-flight Promise of one

  let oneShot = null;
  function ensureOneShot() {
    if (oneShot) return oneShot;
    const rig = makeSceneRig();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(THUMB_SIZE, THUMB_SIZE, false);
    renderer.setClearColor(0x000000, 0);
    oneShot = { ...rig, renderer };
    return oneShot;
  }

  /** @returns {Promise<string>} a PNG data URL — the model's own real 3D geometry/material,
   *  rendered once and cached. */
  async function renderThumbnail(tileset, model) {
    const key = `${tileset}:${model.name}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const promise = (async () => {
      await ctx.get('tiles').load(tileset);
      const { scene, camera, renderer } = ensureOneShot();
      const world = ctx.get('tiles').buildInstances(
        scene, tileset, [{ modelId: model.id, cx: 0, cz: 0, y: 0, rot: 0 }],
        { name: 'studio-thumb', contact: 0 },
      );
      frameOn(camera, model);
      renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      world.dispose();
      return url;
    })();
    cache.set(key, promise);
    promise.then((url) => cache.set(key, url)).catch(() => cache.delete(key));
    return promise;
  }

  /**
   * A persistent, drag-to-orbit live view of one model at a time — the asset detail panel's own
   * mini-viewport. `container` is expected to keep a stable CSS box size (`ResizeObserver`
   * matches the renderer to it); the canvas itself is created once and never torn down by a
   * caller re-rendering the surrounding DOM around it, so a repeated `detail.innerHTML = ''`
   * elsewhere in the panel does not have to avoid this element — moving an already-constructed
   * canvas back into a freshly rebuilt subtree is a normal DOM operation and keeps its live WebGL
   * context intact.
   */
  function mountLiveModelView(container) {
    const rig = makeSceneRig();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.cursor = 'grab';
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    let world = null;
    let currentModel = null;
    let currentTileset = null;
    let yaw = 0;

    function render() {
      if (!currentModel) return;
      frameOn(rig.camera, currentModel, yaw);
      renderer.render(rig.scene, rig.camera);
    }
    function resize() {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h, false);
      render();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let dragging = false;
    let lastX = 0;
    renderer.domElement.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      renderer.domElement.setPointerCapture(e.pointerId);
      renderer.domElement.style.cursor = 'grabbing';
    });
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      yaw += (e.clientX - lastX) * 0.012;
      lastX = e.clientX;
      render();
    });
    function endDrag() { dragging = false; renderer.domElement.style.cursor = 'grab'; }
    renderer.domElement.addEventListener('pointerup', endDrag);
    renderer.domElement.addEventListener('pointercancel', endDrag);

    /** Swaps which model this view shows — disposes the previous one-placement world (if any)
     *  and builds a new one, keeping the same renderer/canvas/context alive across calls. */
    async function setModel(tileset, model) {
      currentModel = model;
      currentTileset = tileset;
      yaw = 0;
      world?.dispose();
      world = null;
      await ctx.get('tiles').load(tileset);
      if (currentModel !== model || currentTileset !== tileset) return; // superseded mid-load
      world = ctx.get('tiles').buildInstances(
        rig.scene, tileset, [{ modelId: model.id, cx: 0, cz: 0, y: 0, rot: 0 }],
        { name: 'studio-live-detail', contact: 0 },
      );
      resize();
    }

    return {
      setModel,
      dispose() {
        ro.disconnect();
        world?.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      },
    };
  }

  return {
    renderThumbnail,
    mountLiveModelView,
    dispose() {
      oneShot?.renderer.dispose();
      oneShot = null;
      cache.clear();
    },
  };
}
