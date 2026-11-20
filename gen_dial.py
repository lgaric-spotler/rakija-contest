"""Generates the juror score dial (paddle + number disc + glue-on retaining circle) as STL files.

Run:  python gen_dial.py <output_dir>
Needs: numpy, shapely, trimesh, manifold3d, matplotlib, mapbox_earcut
All dimensions in mm. Tweak the parameters below and re-run.
"""
import math
import sys
from pathlib import Path

import numpy as np
import trimesh
from matplotlib.font_manager import FontProperties
from matplotlib.textpath import TextPath
from shapely import affinity
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

# ---- parameters -----------------------------------------------------------
HEAD_R = 54.0          # paddle head radius
HANDLE_W = 28.0
HANDLE_L = 70.0        # handle length below the head (total paddle length 178 mm)
BASE_T = 4.0
PIN_D = 8.0
DISC_R = 46.0
DISC_T = 3.0           # disc plate; numbers print on top (change filament at this Z)
DISC_HOLE_D = 8.6      # 0.3 mm radial clearance -> disc turns freely
NUM_H = 1.2            # raised number height
NUM_SIZE = 15.0        # glyph height
NUM_RADIUS = 32.0      # distance from centre to number centre
CIRCLE_D = 2 * DISC_HOLE_D   # retaining circle: 100 % larger than the hole in the number disc (17.2 mm)
CIRCLE_T = 2.0               # plain flat circle, glued onto the end of the pin
PIN_TOP_ABOVE_DISC_GAP = 4.0 # keeps the pin height of the already printed base unchanged (7.4 mm)
RING_T = 4.0 * 0.7           # 30 % thinner than the 4.0 mm that fills the pin height
RING_OD = CIRCLE_D           # same outer diameter as the circle (17.2 mm)
RING_HOLE_D = 8.4            # blind socket that is glued onto the pin end (pin is 8.0 mm)
RING_HOLE_DEPTH = RING_T * 0.5   # socket = 50 % of the part height, the other 50 % is a full closed circle
AXIAL_PLAY = 0.4
POINTER_H = 3.0
POINTER_W = 9.0
# ---------------------------------------------------------------------------


def extrude(geom, height, z0=0.0):
    parts = geom.geoms if hasattr(geom, "geoms") else [geom]
    meshes = []
    for g in parts:
        m = trimesh.creation.extrude_polygon(g, height)
        m.apply_translation([0, 0, z0])
        meshes.append(m)
    return trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]


def union(meshes):
    return trimesh.boolean.union(meshes, engine="manifold")


def difference(a, b):
    return trimesh.boolean.difference([a, b], engine="manifold")


def cylinder(r, h, z0=0.0, sections=96):
    m = trimesh.creation.cylinder(radius=r, height=h, sections=sections)
    m.apply_translation([0, 0, z0 + h / 2])
    return m


def glyph_polygon(text, size):
    """Text as a shapely geometry (even-odd so holes in 6/8/9/0 work), centred at origin."""
    tp = TextPath((0, 0), text, size=size, prop=FontProperties(family="DejaVu Sans", weight="bold"))
    geom = None
    for ring in tp.to_polygons():
        if len(ring) < 3:
            continue
        p = Polygon(ring).buffer(0)
        geom = p if geom is None else geom.symmetric_difference(p)
    minx, miny, maxx, maxy = geom.bounds
    return affinity.translate(geom, -(minx + maxx) / 2, -(miny + maxy) / 2)


def make_base():
    head = Point(0, 0).buffer(HEAD_R, 128)
    handle = box(-HANDLE_W / 2, -HEAD_R - HANDLE_L, HANDLE_W / 2, -HEAD_R + 5)
    outline = unary_union([head, handle])
    outline = outline.buffer(-4, join_style=1).buffer(4, join_style=1)  # soften inner corners
    outline = outline.buffer(3, join_style=1).buffer(-3, join_style=1)
    body = extrude(outline, BASE_T)
    pin_h = DISC_T + AXIAL_PLAY + PIN_TOP_ABOVE_DISC_GAP
    pin = cylinder(PIN_D / 2, pin_h, z0=BASE_T - 0.01)
    # pointer triangle on the head ring (apex toward the centre)
    tri = Polygon([(-POINTER_W / 2, HEAD_R - 1.0), (POINTER_W / 2, HEAD_R - 1.0), (0, DISC_R + 1.5)])
    pointer = extrude(tri, POINTER_H, z0=BASE_T - 0.01)
    return union([body, pin, pointer])


def make_disc():
    plate = cylinder(DISC_R, DISC_T)
    plate = difference(plate, cylinder(DISC_HOLE_D / 2, DISC_T + 2, z0=-1))
    nums = []
    for k in range(1, 11):
        phi = 90.0 - (k - 1) * 36.0          # clockwise, number 1 at the top
        g = glyph_polygon(str(k), NUM_SIZE)
        if k in (6, 9):   # underline so 6 and 9 are never confused
            g = unary_union([g, box(-4.5, -NUM_SIZE / 2 - 3.2, 4.5, -NUM_SIZE / 2 - 1.7)])
        g = affinity.rotate(g, phi - 90.0, origin=(0, 0))   # glyph 'up' points radially outward
        g = affinity.translate(g, NUM_RADIUS * math.cos(math.radians(phi)),
                               NUM_RADIUS * math.sin(math.radians(phi)))
        nums.append(extrude(g, NUM_H, z0=DISC_T - 0.01))
    return union([plate] + nums)


def make_ring():
    """Closed circle with a blind socket in the middle (opens at z=0, depth = 50 % of the height)."""
    return difference(cylinder(RING_OD / 2, RING_T), cylinder(RING_HOLE_D / 2, RING_HOLE_DEPTH + 1, z0=-1))


def make_circle():
    return cylinder(CIRCLE_D / 2, CIRCLE_T)


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    base, disc, circle, ring = make_base(), make_disc(), make_circle(), make_ring()
    base.export(out / "dial_base.stl")
    disc.export(out / "dial_disc.stl")
    circle.export(out / "dial_circle.stl")
    ring_print = ring.copy()     # flipped: closed face on the bed, socket faces up (no supports)
    ring_print.apply_transform(trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0]))
    ring_print.apply_translation([0, 0, RING_T])
    ring_print.export(out / "dial_ring.stl")

    # --- assembled-position checks: parts must not collide ----------------------
    pin_h = DISC_T + AXIAL_PLAY + PIN_TOP_ABOVE_DISC_GAP
    disc_a = disc.copy()
    disc_a.apply_translation([0, 0, BASE_T])
    circle_a = circle.copy()
    circle_a.apply_translation([0, 0, BASE_T + pin_h])      # glued flat on the end of the pin
    ring_a = ring.copy()
    ring_a.apply_translation([0, 0, BASE_T + pin_h - RING_HOLE_DEPTH])   # socket glued onto the pin end
    report = {}
    for label, (a, b) in {"base/disc": (base, disc_a), "disc/circle": (disc_a, circle_a), "base/circle": (base, circle_a),
                          "base/ring": (base, ring_a), "disc/ring": (disc_a, ring_a)}.items():
        inter = trimesh.boolean.intersection([a, b], engine="manifold")
        report[label] = float(abs(inter.volume)) if len(inter.vertices) else 0.0
    for name, m in (("base", base), ("disc", disc), ("circle", circle), ("ring", ring)):
        print(f"{name}: watertight={m.is_watertight} volume={m.volume:.0f} mm3 "
              f"bbox={np.round(m.extents, 1).tolist()}")
    print("circle / disc-hole diameter ratio:", round(CIRCLE_D / DISC_HOLE_D, 2),
          "| circle / pin diameter ratio:", round(CIRCLE_D / PIN_D, 2))
    print("ring: height", RING_T, "| socket depth", RING_HOLE_DEPTH, "| closed top", RING_T - RING_HOLE_DEPTH, "| socket", RING_HOLE_D, "vs pin", PIN_D)
    print("play of the disc under the ring:", round((pin_h - RING_HOLE_DEPTH) - DISC_T, 1), "mm")
    print("collision volumes (mm3, expect ~0):", {k: round(v, 3) for k, v in report.items()})
    return report


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "stl")
