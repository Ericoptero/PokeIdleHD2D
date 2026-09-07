"""
Rebuilds the leaning 45-degree sprites as real geometry, in the AdAstra style (DECISIONS #15).

Run inside Blender:

    exec(open('/path/to/tools/props/adapt.py').read())

Why a solid of revolution rather than a billboard. Looking at the sprites decides it: every
one of them is already drawn in three-quarter view with its *top surface* visible -- a rock
dome seen from above, a barrel with its lid showing. Standing that upright as a billboard
would point the lid at the horizon. AdAstra never does that either; its own small rocks
(`rot_rocks`) are flat ground decals and its *trees* are the cross-billboards, because a tree
sprite is drawn front-on.

So each sprite is read as what it is: the 45-degree projection of a roughly axial object.
The silhouette's half-width at each height gives a radius, the radii are revolved into a
low-poly solid, and the original sprite is projected back onto that solid from the exact
angle it was drawn at. From the game camera the prop looks like the sprite it came from;
from every other angle, and to the sun, it is now a volume that occludes and casts properly.

Logs lie down, so they revolve about a horizontal axis instead; planters are a box; the
conifer keeps AdAstra's crossed-billboard-plus-slices treatment because it is drawn front-on.
"""

import bpy, bmesh, json, math, os
from mathutils import Vector

REPO = "/Users/ericnantes/Developer/PokeIdleHD2D"
TILES = os.path.join(REPO, "public", "generated", "tiles")
OUT = os.path.join(REPO, "assets", "props")

# Everything here is built in **Blender's own Z-up space**, and exported that way, because
# tools/assets/obj.js already converts a Z-up export with `swapYZ` -- the same path the
# authored structures take. Mapping to ARCHITECTURE 3.1: Blender X is east, Blender Y is
# south, Blender Z is up.
UP = Vector((0.0, 0.0, 1.0))
SOUTH = Vector((0.0, 1.0, 0.0))
EAST = Vector((1.0, 0.0, 0.0))

# The camera the art was drawn for, and that the game uses: 45 degrees of pitch, no yaw,
# sitting to the south of what it looks at.
K = math.sqrt(0.5)
VIEW = Vector((0.0, -K, -K))            # the direction the camera looks along
SPRITE_UP = Vector((0.0, -K, K))        # screen-up, in world
SPRITE_RIGHT = EAST

ALPHA = 0.35        # what counts as opaque, matching the runtime's alphaTest
SEGMENTS = 8        # around the axis; AdAstra props sit at 16-30 triangles
ROWS = 5            # along the axis


# ---------------------------------------------------------------------------
# sprite reading
# ---------------------------------------------------------------------------

def load_atlas(path):
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    px = list(img.pixels)          # RGBA floats, row 0 at the bottom
    return px, w, h


def crop_mask(px, w, h, uv):
    """The sprite's alpha mask, cropped to its UV rect, with the atlas wrapping."""
    x0, x1 = uv["u0"] * w, uv["u1"] * w
    y0, y1 = uv["v0"] * h, uv["v1"] * h
    cw, ch = max(1, int(round(x1 - x0))), max(1, int(round(y1 - y0)))
    mask = [[0.0] * cw for _ in range(ch)]
    for j in range(ch):
        for i in range(cw):
            # V was negated on export, so the sprite's own "up" is -V on the atlas.
            sx = int(math.floor(x0 + i)) % w
            sy = int(math.floor(y0 + j)) % h
            mask[j][i] = px[((h - 1 - sy) * w + sx) * 4 + 3]
    return mask, cw, ch


def tight_bounds(mask, cw, ch):
    """The opaque bounding box, so padding in the sheet does not become empty geometry."""
    xs = [i for j in range(ch) for i in range(cw) if mask[j][i] > ALPHA]
    ys = [j for j in range(ch) for i in range(cw) if mask[j][i] > ALPHA]
    if not xs:
        return 0, cw - 1, 0, ch - 1
    return min(xs), max(xs), min(ys), max(ys)


def half_widths(mask, cw, ch, box, rows):
    """
    Silhouette half-width at `rows` levels, returned **foot first**, normalised to 0..1.

    `mask` is indexed in atlas order, which runs down the sprite, so the walk is reversed on
    the way out. A barrel is symmetric enough to hide this; a conifer is not, and would come
    out balanced on its tip.
    """
    x0, x1, y0, y1 = box
    out = []
    for k in range(rows):
        t = k / (rows - 1)
        j = int(round(y0 + t * (y1 - y0)))
        band = range(max(y0, j - 1), min(y1, j + 1) + 1)
        widest = 0
        for jj in band:
            xs = [i for i in range(x0, x1 + 1) if mask[jj][i] > ALPHA]
            if xs:
                widest = max(widest, (max(xs) - min(xs) + 1))
        out.append(widest / max(1, (x1 - x0 + 1)))
    return out[::-1]


# ---------------------------------------------------------------------------
# geometry
# ---------------------------------------------------------------------------

def sprite_uv(fu, fv, uv):
    """
    Sprite-space to atlas UV. `fv` runs 0 at the sprite's *foot* to 1 at its top, which is
    what the geometry thinks in; the atlas rect runs the other way because V is negated on
    export (tools/assets/pdsts.js), so it is flipped once, here, rather than at each caller.
    """
    return (uv["u0"] + fu * (uv["u1"] - uv["u0"]),
            1.0 - (uv["v1"] - fv * (uv["v1"] - uv["v0"])))


def project_uv(co, origin, span_u, span_v, uv):
    """Where a world point lands on the sprite, projected along the camera axis."""
    d = co - origin
    return sprite_uv(d.dot(SPRITE_RIGHT) / span_u, d.dot(SPRITE_UP) / span_v, uv)


def revolve(bm, radii, height, radius, upright, origin):
    """A low-poly solid of revolution, plus a flat cap at each end."""
    # An axial prop revolves about Z (it stands up); a felled log revolves about X (it lies
    # across the cell, east-west, which is how both log sprites are drawn).
    axis = UP if upright else EAST
    a, b = (EAST, SOUTH) if upright else (SOUTH, UP)

    rings = []
    for k, rr in enumerate(radii):
        t = k / (len(radii) - 1)
        centre = axis * (t * height)
        ring = []
        for s in range(SEGMENTS):
            ang = 2 * math.pi * s / SEGMENTS
            p = centre + (a * math.cos(ang) + b * math.sin(ang)) * (rr * radius)
            ring.append(bm.verts.new(origin + p))
        rings.append(ring)

    body, caps = [], []
    for k in range(len(rings) - 1):
        lo, hi = rings[k], rings[k + 1]
        for s in range(SEGMENTS):
            t = (s + 1) % SEGMENTS
            quad = [lo[s], lo[t], hi[t], hi[s]]
            if len(set(quad)) < 4:
                continue
            try:
                f = bm.faces.new(quad)
            except ValueError:
                continue
            # Remember where each corner sits on the body: `s` around, `k` up.
            body.append((f, [(s, k), (t, k), (t, k + 1), (s, k + 1)]))
    for ring, flip in ((rings[0], True), (rings[-1], False)):
        if len(set(ring)) >= 3:
            try:
                caps.append((bm.faces.new(ring[::-1] if flip else ring), flip))
            except ValueError:
                pass
    return rings, body, caps


def build_solid(name, radii, size, upright, uv):
    """`size` is (width, height) in cells; the sprite is projected on from the view axis."""
    w, h = size
    bm = bmesh.new()
    radius = w * 0.5
    # The prop sits inside its cell: centred in X and Y, standing on z=0.
    base = Vector((w * 0.5, w * 0.5, 0.0)) if upright else Vector((0.0, h * 0.5, radius))
    rings, body, caps = revolve(bm, radii, h, radius, upright, base)
    bm.normal_update()
    uv_layer = bm.loops.layers.uv.new("UVMap")

    # Cylindrical, not projected. A single planar projection smears the silhouette edge round
    # the sides and drags the grass the artist drew at the foot of the sprite up the body;
    # wrapping the sprite around the axis instead keeps every row at the height it was drawn
    # at, all the way round, which is what a barrel band or a mossy base needs.
    rows = len(radii) - 1
    for f, corners in body:
        for loop, (s_i, k_i) in zip(f.loops, corners):
            # Fold the sprite so u runs out and back: the far side sees the sprite mirrored,
            # which beats a seam where u wraps from 1 to 0.
            a = (s_i / SEGMENTS) * 2.0
            fu = a if a <= 1.0 else 2.0 - a
            loop[uv_layer].uv = sprite_uv(fu, k_i / rows, uv)

    # The caps take a top-down slice of the sprite's own top (or bottom) rows.
    for f, is_bottom in caps:
        # Sample from *inside* the silhouette, not off its edge. The top rows of a rock
        # sprite are its lit rim, and stretching those across a cap turns a boulder into a
        # bowl with a pale lip. A cap is small, so a small centred patch is enough.
        band = (0.06, 0.16) if is_bottom else (0.66, 0.78)
        span = 0.34
        for loop in f.loops:
            d = loop.vert.co - base
            fu = 0.5 + (d.dot(EAST) / max(w, 1e-6)) * span
            fv = band[0] + (0.5 + d.dot(SOUTH) / max(w, 1e-6)) * (band[1] - band[0])
            loop[uv_layer].uv = sprite_uv(min(max(fu, 0.0), 1.0), fv, uv)

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def build_ground_quad(ob, w, d, uv, y=0.03):
    """AdAstra grounds every prop with a flat quad near y=0; without it a prop floats."""
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.verify()
    vs = [bm.verts.new(Vector(p)) for p in
          ((0, 0, y), (w, 0, y), (w, d, y), (0, d, y))]
    try:
        f = bm.faces.new(vs)
        # the bottom band of the sprite is its own contact shadow
        corners = ((uv["u0"], 1 - uv["v0"]), (uv["u1"], 1 - uv["v0"]),
                   (uv["u1"], 1 - (uv["v0"] + (uv["v1"] - uv["v0"]) * 0.25)),
                   (uv["u0"], 1 - (uv["v0"] + (uv["v1"] - uv["v0"]) * 0.25)))
        for loop, c in zip(f.loops, corners):
            loop[uv_layer].uv = c
    except ValueError:
        pass
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()


def build_crossed(name, size, uv, radii=None, slices=0):
    """
    AdAstra's own tree: two upright quads crossing at the cell centre. Measured off
    `bw2-adastra/tree`, which also carries horizontal slice quads at y = 0.19, 1.63 and 3.72
    of 4.50 -- and those are **off by default here**, which is a deliberate departure.

    AdAstra's slices work because that tree ships four materials, one per layer, each drawn
    as a top-down canopy. Ours would have to take a horizontal band of a *front-view* sprite
    and stretch it across the footprint, which on screen is three grey plates through the
    tree rather than canopy depth. Without the top-down art the trick has nothing to draw,
    so the blades stand alone; pass `slices` to opt back in if a sprite ever gets that art.
    """
    w, h = size
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    c = w * 0.5

    def quad(pts, corners):
        vs = [bm.verts.new(Vector(p)) for p in pts]
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return
        for loop, uvc in zip(f.loops, corners):
            loop[uv_layer].uv = sprite_uv(uvc[0], uvc[1], uv)

    full = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))

    # The two upright blades, each spanning the whole sprite -- and each emitted twice, once
    # per winding. A blade is a plane, so one of its two sides always faces away from the
    # camera and is culled; the first pass through this showed nothing on screen but a
    # perfect tree-shaped shadow, because three renders shadows from the opposite face. The
    # alternative is a double-sided material, which would mean new plumbing through the pack
    # for four extra triangles.
    def blade(pts):
        quad(pts, full)
        quad(list(reversed(pts)), tuple(reversed(full)))

    blade([(0, c, 0), (w, c, 0), (w, c, h), (0, c, h)])
    blade([(c, 0, 0), (c, w, 0), (c, w, h), (c, 0, h)])

    # Horizontal slices: each takes the band of the sprite it sits at, so a canopy layer
    # shows canopy and a base layer shows trunk. Each is inset to the silhouette's own width
    # at that height -- a slice that spans the whole footprint sticks out past the blades and
    # reads as a shelf through the tree.
    for i in range(slices):
        t = 0.06 + (i / max(slices - 1, 1)) * 0.74
        z = t * h
        r = 0.5
        if radii:
            k = t * (len(radii) - 1)
            lo = radii[min(int(k), len(radii) - 1)]
            hi = radii[min(int(k) + 1, len(radii) - 1)]
            r = 0.5 * (lo + (hi - lo) * (k - int(k)))
        a, b = c - w * r, c + w * r
        band = (max(t - 0.05, 0.0), min(t + 0.05, 1.0))
        quad([(a, a, z), (b, a, z), (b, b, z), (a, b, z)],
             ((0.5 - r, band[0]), (0.5 + r, band[0]), (0.5 + r, band[1]), (0.5 - r, band[1])))

    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def build_planter(name, size, uv):
    """The "hedge" sprites are a shrub sitting in a square planter, so: a box, and a dome."""
    w, h = size
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    rim = h * 0.42                       # where the planter stops and the shrub starts

    def quad(pts, corners):
        vs = [bm.verts.new(Vector(p)) for p in pts]
        try:
            f = bm.faces.new(vs)
        except ValueError:
            return
        for loop, uvc in zip(f.loops, corners):
            loop[uv_layer].uv = sprite_uv(uvc[0], uvc[1], uv)

    side = ((0.0, 0.0), (1.0, 0.0), (1.0, 0.42), (0.0, 0.42))
    quad([(0, 0, 0), (w, 0, 0), (w, 0, rim), (0, 0, rim)], side)
    quad([(w, w, 0), (0, w, 0), (0, w, rim), (w, w, rim)], side)
    quad([(w, 0, 0), (w, w, 0), (w, w, rim), (w, 0, rim)], side)
    quad([(0, w, 0), (0, 0, 0), (0, 0, rim), (0, w, rim)], side)

    # the shrub: a shallow dome of the sprite's upper band, on the planter rim
    ring = []
    for k, r in enumerate((1.0, 0.92, 0.6)):
        zz = rim + (h - rim) * (k / 3.0)
        row = []
        for sN in range(SEGMENTS):
            a = 2 * math.pi * sN / SEGMENTS
            row.append(bm.verts.new(Vector((w * 0.5 + math.cos(a) * w * 0.5 * r,
                                            w * 0.5 + math.sin(a) * w * 0.5 * r, zz))))
        ring.append(row)
    for k in range(len(ring) - 1):
        for sN in range(SEGMENTS):
            t = (sN + 1) % SEGMENTS
            try:
                f = bm.faces.new([ring[k][sN], ring[k][t], ring[k + 1][t], ring[k + 1][sN]])
            except ValueError:
                continue
            for loop, (si, ki) in zip(f.loops, ((sN, k), (t, k), (t, k + 1), (sN, k + 1))):
                a = (si / SEGMENTS) * 2.0
                fu = a if a <= 1.0 else 2.0 - a
                loop[uv_layer].uv = sprite_uv(fu, 0.45 + 0.5 * (ki / 2.0), uv)
    try:
        f = bm.faces.new(ring[-1])
        for loop in f.loops:
            d = loop.vert.co - Vector((w * 0.5, w * 0.5, 0))
            loop[uv_layer].uv = sprite_uv(0.5 + d.x / w, 0.86, uv)
    except ValueError:
        pass

    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def build_decal(name, size, uv, y=0.03):
    """
    A flat quad just above the ground. This is AdAstra's own answer for small scatter --
    `rot_rocks` is two triangles at y=0.12 -- and it is right for anything with no height to
    speak of, like a tool left lying in the grass.
    """
    w, d = size
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    vs = [bm.verts.new(Vector(p)) for p in ((0, 0, y), (w, 0, y), (w, d, y), (0, d, y))]
    f = bm.faces.new(vs)
    for loop, c in zip(f.loops, ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))):
        loop[uv_layer].uv = sprite_uv(c[0], c[1], uv)
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


# ---------------------------------------------------------------------------
# recipes
# ---------------------------------------------------------------------------

# What each sprite actually is, read off the art rather than off its name.
#   axial   - roughly symmetric about the vertical axis: rocks, barrel, log pile, bush
#   lying   - symmetric about a horizontal axis: a felled log
#   planter - a box: the "hedge" sprites are a shrub in a square planter
#   conifer - drawn front-on, so it keeps AdAstra's crossed billboards + slices
#   decal   - stays a flat ground quad
RECIPES = {
    "small_rock": "axial", "water_rock_small": "axial", "water_rock": "axial",
    "rock": "axial", "rock_small": "axial", "rock_tall": "axial",
    "barrel": "axial",
    # A stack is not a solid of revolution -- revolving it weaves the log ends into a basket.
    # It is drawn front-on, so it takes the crossed-billboard treatment.
    "pile_of_logs": "conifer",
    "log": "lying", "fat_log": "lying",
    "hedge": "planter",
    "tree_mush": "conifer",
    "axe": "decal", "axe_rotated": "decal",
}


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for me in list(bpy.data.meshes):
        bpy.data.meshes.remove(me)


def adapt_one(entry, report):
    slug, name = entry["slug"], entry["name"]
    recipe = RECIPES.get(name, "axial")
    atlas = os.path.join(TILES, slug, "tex", entry["atlas"])
    px, aw, ah = load_atlas(atlas)
    uv = dict(entry["uv"])
    # A rect whose start sits at or past 1.0 has been shifted by a whole tile; bring it back.
    for k0, k1 in (("u0", "u1"), ("v0", "v1")):
        if uv[k0] >= 1.0:
            uv[k0] -= 1.0
            uv[k1] -= 1.0

    mask, cw, ch = crop_mask(px, aw, ah, uv)
    box = tight_bounds(mask, cw, ch)
    x0, x1, y0, y1 = box
    pxw, pxh = x1 - x0 + 1, y1 - y0 + 1

    # Narrow the atlas rect to the opaque part. The sheets carry a margin of grass around
    # each sprite, and a cylindrical wrap would otherwise fold that margin onto the prop as a
    # green sliver down the side it meets itself on.
    du, dv = uv["u1"] - uv["u0"], uv["v1"] - uv["v0"]
    uv = {
        "u0": uv["u0"] + (x0 / cw) * du, "u1": uv["u0"] + ((x1 + 1) / cw) * du,
        "v0": uv["v0"] + (y0 / ch) * dv, "v1": uv["v0"] + ((y1 + 1) / ch) * dv,
    }
    box = (0, pxw - 1, 0, pxh - 1)
    mask = [[mask[y0 + j][x0 + i] for i in range(pxw)] for j in range(pxh)]
    cw, ch = pxw, pxh

    # Width comes from the quad the sprite was drawn on; height comes from the sprite's own
    # pixel aspect. The quads are non-uniformly scaled -- the barrel's is 0.0625 world units
    # per texel across and 0.0815 up -- so taking the height from the quad stretches every
    # prop by a third. Square texels are what the artist drew.
    b = entry["bounds"]
    quad_w = (b["max"][0] - b["min"][0]) * (pxw / cw)
    screen_h = quad_w * (pxh / max(pxw, 1))

    # An axial object of height h and radius r projects to 0.707*h + 1.414*r of screen
    # height at 45 degrees, so the height the artist implied is recoverable.
    radius = quad_w * 0.5
    height = max(0.15, (screen_h - radius * math.sqrt(2.0)) * math.sqrt(2.0))

    radii = half_widths(mask, cw, ch, box, ROWS)
    peak = max(radii) or 1.0
    radii = [r / peak for r in radii]

    # A silhouette that has already narrowed sharply by its top row is a dome, and a dome
    # closes. Leaving it at the measured width caps a boulder with a flat disc that samples
    # the sprite's brightest row and reads as a lid. A barrel, whose top row is still wide,
    # keeps its lid -- which is the difference the threshold is picking out.
    if recipe == "axial" and radii[-1] < 0.45:
        radii[-1] = 0.06

    ob = None
    if recipe == "decal":
        ob = build_decal(f"{slug}__{name}", (quad_w, max(0.2, screen_h)), uv)
    elif recipe == "conifer":
        ob = build_crossed(f"{slug}__{name}",
                           (quad_w, max(0.3, screen_h * math.sqrt(2.0) * 0.8)), uv, radii)
    elif recipe == "planter":
        ob = build_planter(f"{slug}__{name}", (quad_w, max(0.3, screen_h)), uv)
    elif recipe in ("axial", "lying"):
        upright = recipe == "axial"
        if not upright:
            # A felled log lies east-west. Its cross-section is a circle in the plane facing
            # the camera, so the sprite's height is the diameter directly -- no 45-degree
            # correction -- and the sprite's width is the length.
            height = quad_w                 # length along X
            quad_w = max(0.2, screen_h)     # diameter
            radius = quad_w * 0.5
        ob = build_solid(f"{slug}__{name}", radii, (quad_w, height), upright, uv)

    report.append({
        "slug": slug, "name": name, "recipe": recipe,
        "sprite_px": [pxw, pxh], "width": round(quad_w, 3), "height": round(height, 3),
        "screen_h": round(screen_h, 3), "uv": {k: round(v, 6) for k, v in uv.items()},
        "radii": [round(r, 2) for r in radii],
        "tris": len(ob.data.polygons) if ob else 0,
    })
    return ob


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def export_one(ob, entry, uv_used):
    """
    Writes the prop where `tools/props/build-props.js` expects it: one folder per prop with
    an OBJ, an MTL and its texture, exactly the shape `assets/structures/` uses so the pack
    step is shared.

    The OBJ is written Z-up, unconverted, because tools/assets/obj.js already reads that with
    `swapYZ` -- the same path the authored buildings take (DECISIONS #12).
    """
    slug, name = entry["slug"], entry["name"]
    folder = os.path.join(OUT, f"{slug}__{name}")
    os.makedirs(folder, exist_ok=True)

    # The UVs go out exactly as built. `sprite_uv` returns a GL-style V so the Blender
    # previews match what the game will draw, the OBJ format stores V the other way up, and
    # tools/assets/obj.js flips it back on import -- the two cancel. Flipping here as well
    # samples the mirrored band, which for a sprite that is a sub-rect of a shared atlas is
    # a different picture entirely (the barrel becomes the log pile beside it).
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob

    bpy.ops.wm.obj_export(
        filepath=os.path.join(folder, f"{name}.obj"),
        export_selected_objects=True, forward_axis='Y', up_axis='Z',
        export_materials=True, export_normals=True, export_uv=True,
        export_triangulated_mesh=True, apply_modifiers=True,
        path_mode='COPY',
    )
    with open(os.path.join(folder, "meta.json"), "w") as f:
        json.dump({
            "source": {"tileset": slug, "model": name, "atlas": entry["atlas"]},
            "recipe": RECIPES.get(name, "axial"),
            "category": entry["category"], "subcategory": entry.get("subcategory"),
            "tags": sorted(set(entry.get("tags", [])) | {"adapted"}),
            "biomes": entry.get("biomes", ["any"]),
            "collision": entry.get("collision", "block"),
            "w": max(1, int(round(ob.dimensions.x))), "h": max(1, int(round(ob.dimensions.y))),
            "uv": uv_used,
            "tris": len(ob.data.polygons),
            "dimensions": [round(v, 4) for v in ob.dimensions],
        }, f, indent=1)
    return folder


def run_all(only=None):
    """Rebuild every prop on the worklist and export it. Returns a report to print."""
    work = json.load(open(os.path.join(REPO, "tools", "props", "worklist.json")))["models"]
    if only:
        work = [w for w in work if w["name"] in only]
    report, failures = [], []
    for entry in work:
        clear_scene()
        try:
            ob = adapt_one(entry, report)
            if ob is None:
                failures.append(f"{entry['slug']}/{entry['name']}: recipe "
                                f"{RECIPES.get(entry['name'], 'axial')} produced no mesh")
                continue
            atlas = os.path.join(TILES, entry["slug"], "tex", entry["atlas"])
            img = bpy.data.images.load(atlas, check_existing=True)
            mat = bpy.data.materials.new(entry["atlas"].replace(".png", ""))
            mat.use_nodes = True
            nt = mat.node_tree
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img; tex.interpolation = 'Closest'; tex.extension = 'REPEAT'
            bsdf = nt.nodes["Principled BSDF"]
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
            ob.data.materials.append(mat)
            export_one(ob, entry, report[-1].get("uv"))
        except Exception as exc:                       # one bad prop must not stop the batch
            failures.append(f"{entry['slug']}/{entry['name']}: {exc}")
    return {"report": report, "failures": failures}
