/**
 * Turns PDSMS tile records into catalog entries with human-meaningful names, a category,
 * and tags the world builders can query.
 *
 * Two signals drive this:
 *   1. the OBJ filename baked into the tileset (`Tall_mountain_bl.obj`, `ts_5_wr1.obj`)
 *   2. the texture filenames, which are romaji from the retail games and are far more
 *      reliable than the OBJ names in the sets whose authors used `1.obj`, `2.obj`.
 *
 * Anything that lands in category `unknown` is a bug in this file, not an acceptable
 * outcome — the world builders can only place what they can name.
 */

/** Romaji and English fragments found in DS tileset texture names. */
const TEXTURE_LEXICON = [
  [/^ki\d|_ki\d|\bki0/, 'tree', ['tree', 'foliage']],
  [/mori/, 'tree', ['forest', 'foliage']],
  [/plant/, 'plant', ['hedge', 'foliage']],
  [/ue_grass|kusa/, 'plant', ['tallgrass', 'foliage', 'encounter']],
  [/hana|flower/, 'plant', ['flower', 'decor']],
  [/grass/, 'ground', ['grass']],
  [/gake_michi/, 'path', ['path', 'stone']],
  [/gake_futa/, 'ground', ['cliff-top', 'stone']],
  [/michi|road|path/, 'path', ['path', 'dirt']],
  [/yamagake|gake/, 'cliff', ['cliff', 'rock']],
  [/doukutu|cave/, 'cave', ['cave', 'entrance']],
  [/sea_zanami|zanami/, 'water', ['surf', 'foam']],
  [/sea_asase|asase/, 'water', ['shallows', 'wadeable']],
  [/sea_gake/, 'shore', ['shore', 'cliff']],
  [/sea|mizu|ike|river|umi/, 'water', ['water']],
  [/shore|beach|suna|sand/, 'shore', ['shore', 'sand']],
  [/saku|fence/, 'fence', ['fence']],
  [/hashi|bridge/, 'bridge', ['bridge']],
  [/kaidan|stair/, 'stairs', ['stairs']],
  [/dansa|jump/, 'ledge', ['ledge', 'jump']],
  [/isu|bench/, 'prop', ['bench', 'seat']],
  [/slamp|lamp|light/, 'light', ['lamp', 'emissive']],
  [/kage/, 'decal', ['shadow']],
  [/separator/, 'meta', ['separator']],
  [/wall|kabe/, 'wall', ['wall']],
  [/floor|yuka|carpet/, 'interior', ['floor']],
  [/window|mado|glass/, 'building', ['window']],
  [/door|tobira/, 'building', ['door']],
  [/roof|yane/, 'building', ['roof']],
  [/ice|kori/, 'ground', ['ice']],
  [/snow|yuki/, 'ground', ['snow']],
];

/** OBJ-name fragments. Checked before textures because they are more specific when present. */
const NAME_LEXICON = [
  [/forest[_ ]?entrance/i, 'tree', ['forest', 'entrance', 'canopy']],
  [/big[_ ]?tree|round[_ ]?tree|darker[_ ]?pine|^tree|_tree/i, 'tree', ['tree']],
  [/tall[_ ]?grass|grasspatch|grass_decoration/i, 'plant', ['tallgrass', 'encounter']],
  [/hedge/i, 'plant', ['hedge']],
  [/flower/i, 'plant', ['flower', 'decor']],
  [/mushroom|mush/i, 'prop', ['mushroom', 'decor']],
  [/tall[_ ]?mountain|^ts[_ ]?5|^ts5/i, 'cliff', ['cliff', 'tall']],
  [/mountain|montain|rock_mountain/i, 'cliff', ['cliff']],
  [/^rock|_rock|little_rocks|rot_rocks/i, 'prop', ['rock', 'decor']],
  [/lake[_ ]?water|water|sea|pond|swater|mar\b/i, 'water', ['water']],
  [/lake[_ ]?(corner|straight|border)/i, 'shore', ['shore', 'lake']],
  [/walk_edge|walkable_water/i, 'water', ['shallows', 'wadeable']],
  [/shore|beach/i, 'shore', ['shore']],
  [/sand[_ ]?path|sand[_ ]?road|dirt|sterr|rot_dirtpatch/i, 'path', ['path', 'dirt']],
  [/grass[_ ]?path|graypath|road|^sroad|^groad|artroad/i, 'path', ['path']],
  [/^grass$|^grass\.|grass_small/i, 'ground', ['grass']],
  [/fence/i, 'fence', ['fence']],
  [/bridge|bride/i, 'bridge', ['bridge']],
  [/stairs|climb/i, 'stairs', ['stairs']],
  [/jump/i, 'ledge', ['ledge', 'jump']],
  [/bench/i, 'prop', ['bench', 'seat']],
  [/lamp/i, 'light', ['lamp', 'emissive']],
  [/cave/i, 'cave', ['cave']],
  [/shadow|^kage|tree[_ ]?shadow/i, 'decal', ['shadow']],
  [/separator/i, 'meta', ['separator']],
  [/barrel|log|axe|pile/i, 'prop', ['prop', 'rustic']],
  [/house|rancho|tower|stage|wallcorner/i, 'building', ['building']],
  [/window|glass/i, 'building', ['window']],
  [/^door|_door/i, 'building', ['door']],
  [/wall|pilar|pillar/i, 'wall', ['wall']],
  [/floor|carpet|tile$|smalltile|largetile/i, 'interior', ['floor']],
  [/statue/i, 'prop', ['statue']],
  [/waterfall/i, 'water', ['waterfall']],
  [/estalactita|stalactite/i, 'prop', ['stalactite', 'cave']],
  [/spear|poutre|entry|center3/i, 'prop', ['ruin']],
  [/dust/i, 'decal', ['dust']],
];

/** Orientation suffixes DS tileset authors use, longest match first. */
const ORIENTATION = [
  [/_?cornerin(ul|tl)$/i, 'inner_nw'], [/_?cornerin(ur|tr)$/i, 'inner_ne'],
  [/_?cornerin(dl|bl)$/i, 'inner_sw'], [/_?cornerin(dr|br)$/i, 'inner_se'],
  [/_?corner_?in$/i, 'inner'], [/_?corner_?out$/i, 'outer'],
  [/_ctl$|_c_tl$/i, 'inner_nw'], [/_ctr$|_c_tr$/i, 'inner_ne'],
  [/_cbl$|_c_bl$/i, 'inner_sw'], [/_cbr$|_c_br$/i, 'inner_se'],
  [/_tl$/i, 'nw'], [/_tr$/i, 'ne'], [/_bl$/i, 'sw'], [/_br$/i, 'se'],
  [/_t$|_u$|_top$|_up$/i, 'n'], [/_b$|_d$|_bot$|_down$/i, 's'],
  [/_l$|_left$/i, 'w'], [/_r$|_right$/i, 'e'],
  [/_c$|_center$|_centre$/i, 'center'],
];

/**
 * Friendly names for the textures we ship, so a model called `grass.obj` that is actually
 * painted with `mizu_sita2` ends up named for what it looks like. Falls back to the texture
 * stem, which is still better than a misleading OBJ name.
 */
const TEXTURE_NAMES = {
  grass01ax: 'grass', gake_michi: 'stone_path', gake_futa: 'cliff_top',
  michi01a: 'path_edge', michi01b: 'path', michi_hage: 'worn_path',
  michi_hibi: 'cracked_dirt', michi_isi: 'pebble_path',
  mizu_sita2: 'water_deep', ike01: 'pond_water', river: 'river_water',
  sea_mizu1: 'sea_water', sea_mizu1_1: 'sea_water', sea_asase02: 'shallows',
  sea_zanami2: 'surf', sea_gake01: 'sea_cliff', sea_gake02: 'sea_cliff',
  shore01: 'shore', gake01a: 'cliff_face', gake1_0: 'cliff_face', gake1_1: 'cliff_face',
  gake1_3: 'cliff_face', yamagake01: 'mountain_face',
  ue_grass00: 'grass_tuft', ue_grass01: 'grass_patch',
  kusa_ec1: 'tall_grass', kusa_ec2: 'tall_grass', kusa_ec3: 'tall_grass',
  hana01_1: 'flower', hana01_p: 'flower', kisetu_hana: 'seasonal_flower',
  plant01: 'hedge', saku: 'fence', hashi01a: 'bridge', kaidan01a: 'stairs',
  dansa01a: 'ledge', isu: 'bench', slamp03: 'street_lamp',
  doukutu01: 'cave_mouth', mori01s: 'forest_wall', separator: 'separator',
  h_kage: 'shadow', kage_out: 'shadow',
};

const CATEGORY_COLLISION = {
  ground: 'walk', path: 'walk', shore: 'walk', interior: 'walk', bridge: 'walk',
  stairs: 'stairs', ledge: 'ledge', water: 'water', plant: 'walk', decal: 'walk',
  cliff: 'block', wall: 'block', building: 'block', tree: 'block', fence: 'block',
  prop: 'block', light: 'block', cave: 'door', meta: 'none', unknown: 'block',
};

const BIOME_HINTS = [
  [['grass', 'path', 'flower', 'tallgrass'], ['meadow', 'city', 'forest', 'coast']],
  [['tree', 'forest', 'foliage', 'mushroom'], ['forest']],
  [['cliff', 'rock'], ['forest', 'cave', 'meadow', 'coast']],
  [['water', 'shore', 'surf', 'shallows', 'sand'], ['coast']],
  [['cave', 'stalactite'], ['cave']],
  [['fence', 'bench', 'lamp', 'building', 'window', 'door', 'roof'], ['city']],
  [['ice', 'snow'], ['tundra']],
];

const snake = (s) => s
  .replace(/\.obj$/i, '').replace(/\.mtl$/i, '')
  .replace(/[^A-Za-z0-9]+/g, '_')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();

function lex(list, subject) {
  for (const [re, category, tags] of list) if (re.test(subject)) return { category, tags };
  return null;
}

/**
 * @param {object} tile        parsed tile record
 * @param {object[]} materials tileset materials, indexed by texture id
 * @param {{min:number[],max:number[]}} bounds  world-space bounds after tools/assets/pdsts.js conversion
 * @returns {{category:string, subcategory:string, tags:string[], base:string,
 *            orientation:string|null, collision:string, biomes:string[]}}
 */
/**
 * Categories the OBJ name knows better than any texture: a cave mouth is cut into cliff
 * rock, a bench shares its shadow texture with a lamp, a forest entrance is made of the
 * same leaves as a tree. Everything else defers to the pixels, because DS tileset authors
 * routinely reuse one OBJ under several materials — `grass.obj` in the AdAstra set is
 * painted as grass, as stone paving and as deep water.
 */
const NAME_WINS = new Set(['cave', 'tree', 'bridge', 'stairs', 'ledge', 'prop', 'building',
  'light', 'fence', 'wall', 'interior', 'plant', 'decal', 'meta']);

export function classifyTile(tile, materials, bounds, dominantTextureId = null) {
  const objName = tile.OBJNAME || 'unnamed';
  const ids = tile.TIDS || [];
  const images = ids.map((id) => (materials[id]?.IMG_NAME || '').toLowerCase());
  const primaryId = dominantTextureId ?? ids[0];
  const primaryImage = (materials[primaryId]?.IMG_NAME || '').toLowerCase();

  const nameHit = lex(NAME_LEXICON, objName);
  let texHit = lex(TEXTURE_LEXICON, primaryImage);
  if (!texHit) for (const img of images) { texHit = lex(TEXTURE_LEXICON, img); if (texHit) break; }

  const hit = (nameHit && NAME_WINS.has(nameHit.category)) ? nameHit : (texHit ?? nameHit);
  const category = hit?.category ?? 'unknown';
  const tags = [...(hit?.tags ?? []), ...(texHit && texHit !== hit ? texHit.tags : [])];
  const renamedByTexture = hit === texHit && nameHit && nameHit.category !== texHit.category;

  const stem = snake(objName);
  let orientation = null;
  for (const [re, name] of ORIENTATION) {
    if (re.test(stem)) { orientation = name; break; }
  }

  const t = new Set(tags);
  const height = bounds.max[1] - bounds.min[1];
  const flat = height < 0.02;
  if (flat) t.add('flat');
  if (height >= 2) t.add('tall');
  if (tile.WIDTH > 1 || tile.HEIGHT > 1) t.add('multicell');
  if (bounds.min[1] < -0.01) t.add('sunken');
  // Tiles authored on top of a cliff sit metres above their own cell. Placing one at ground
  // level leaves it floating with a hole under it, so make the distinction queryable.
  if (bounds.min[1] >= 0.5) t.add('raised');
  if (materials.some((m, i) => tile.TIDS?.includes(i) && m?.BOTHFACE)) t.add('billboard');
  if (['tree', 'plant', 'fence', 'light', 'prop'].includes(category)) t.add('occluder');
  if (['ground', 'path', 'shore', 'interior'].includes(category) && flat) t.add('floor');

  const biomes = new Set();
  for (const [needles, adds] of BIOME_HINTS) {
    if (needles.some((n) => t.has(n))) adds.forEach((b) => biomes.add(b));
  }
  if (biomes.size === 0) biomes.add('any');

  // `Tall_mountain_bl` -> subcategory `tall_mountain`, orientation `sw`
  let base = stem;
  if (orientation) {
    for (const [re] of ORIENTATION) {
      if (re.test(base)) { base = base.replace(re, ''); break; }
    }
  }
  base = base.replace(/_+$/, '') || stem;

  // When the pixels overruled the OBJ name, name the model after the pixels too.
  if (renamedByTexture) {
    const stemTex = primaryImage.replace(/\.png$/, '');
    base = TEXTURE_NAMES[stemTex] ?? stemTex.replace(/[^a-z0-9]+/g, '_');
  }

  return {
    category,
    subcategory: base,
    tags: [...t].sort(),
    base,
    orientation,
    collision: CATEGORY_COLLISION[category] ?? 'block',
    biomes: [...biomes].sort(),
  };
}

/**
 * Distinguishes the several tile records that share one OBJ source (PDSMS bakes rotation
 * and mirroring into geometry, so `grass_path_corner.obj` appears eight times).
 *
 * The signature is the quadrant occupancy of the tile's own footprint: which of the four
 * cell quadrants carry geometry above the tile's minimum height, plus the mean UV, which
 * separates rotations that are geometrically identical but texture-rotated.
 */
export function orientationSignature(groups, bounds, cellW, cellH) {
  const q = [0, 0, 0, 0];
  let uSum = 0, vSum = 0, n = 0, above = 0;
  const midX = cellW / 2, midZ = cellH / 2;
  const yFloor = bounds.min[1] + 0.001;

  for (const g of groups) {
    for (let i = 0; i < g.position.length; i += 3) {
      const x = g.position[i], y = g.position[i + 1], z = g.position[i + 2];
      const qi = (x >= midX ? 1 : 0) + (z >= midZ ? 2 : 0);
      q[qi]++;
      if (y > yFloor) above++;
      uSum += g.uv[(i / 3) * 2]; vSum += g.uv[(i / 3) * 2 + 1]; n++;
    }
  }
  const total = q.reduce((a, b) => a + b, 1);
  return [
    ...q.map((c) => Math.round((c / total) * 8)),
    above > 0 ? 1 : 0,
    Math.round((uSum / Math.max(1, n)) * 4),
    Math.round((vSum / Math.max(1, n)) * 4),
  ].join('.');
}

/**
 * PDSMS smart-drawing templates are 5x3 grids of tile indices. Slot n (row-major) carries
 * the neighbour signature below, copied from `SmartGrid.smartUnits` in the Java source:
 * [top, bottom, left, right, topLeft, topRight, bottomLeft, bottomRight].
 *
 * SETTLED: PDSMS's "top" is our north (-Z). Proven from the four inner
 * corners of the grass/path set: the transition-textured triangle of `cornerinUL` sits at
 * cell (0.67, 0.33) = north-east, which is exactly the corner SMART_UNITS[3] leaves empty,
 * and the other three agree. A vertical flip or a 180-degree rotation would both have
 * broken that agreement, so the convention below needs no flip.
 */
export const SMART_UNITS = [
  [1, 0, 0, 1, 0, 0, 0, 0], [1, 0, 1, 1, 0, 0, 0, 0], [1, 0, 1, 0, 0, 0, 0, 0],
  [1, 1, 1, 1, 1, 0, 1, 1], [1, 1, 1, 1, 0, 1, 1, 1],
  [1, 1, 0, 1, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 0, 0, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 0], [1, 1, 1, 1, 1, 1, 0, 1],
  [0, 1, 0, 1, 0, 0, 0, 0], [0, 1, 1, 1, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0],
];

/** Human names for the 13 smart slots, in the same order as SMART_UNITS. */
export const SMART_SLOT_NAMES = [
  'corner_sw', 'edge_s', 'corner_se', 'inner_ne', 'inner_nw',
  'edge_w', 'center', 'edge_e', 'inner_se', 'inner_sw',
  'corner_nw', 'edge_n', 'corner_ne',
];

/** Packs a neighbour signature into a byte: N S W E NW NE SW SE (bit 0 = N). */
export function packSignature([t, b, l, r, tl, tr, bl, br]) {
  return t | (b << 1) | (l << 2) | (r << 3) | (tl << 4) | (tr << 5) | (bl << 6) | (br << 7);
}
