#!/usr/bin/env python3
"""Draws every TrackNothing icon from one mark: the empty set (∅) as a heavy ring and bar, in a 100×100 box.

Two forms of the same shape:
- dots (128 px and up, and drawn marks of 40 pt and up): the ring and bar filled with a halftone of amber dots, lit from the upper left like the
  home page's portrait; dot size carries the light, so the mark stays one colour.
- solid (smaller: menu bar, tray, taskbar, favicon): the same ring and bar in flat colour, a gap where the bar crosses.

Run from the repository root after changing the shape: python3 scripts/brand-icons.py (needs Pillow).
Writes the Apple app icons, the Windows .ico, the Android vectors and public/favicon.svg.
The same geometry is drawn at runtime by each client (Mark in Ui.kt, Design.swift, Look.cs) and by shared/brand.tsx;
keep the constants below in step with them.
"""
import math
from PIL import Image, ImageDraw

BG, AMBER = (17, 15, 12), (224, 164, 88)
APPLE = "clients/apple/App/Assets.xcassets/AppIcon.appiconset"
# Solid form: ring between radii 22.5 and 37.5, cut 13 either side of the bar's centre line, bar 14 wide, 47 half-long.
R_IN, R_OUT, CUT, BAR, HALF = 22.5, 37.5, 13.0, 7.0, 47.0
# Dot form: hex grid pitch 3.4; ring 25…37 cut 11 either side; bar 5.6 either side of the centre line.
PITCH = 3.4


def along(x, y): return ((x - 50) - (y - 50)) / math.sqrt(2)   # along the bar (lower-left → upper-right is +)
def across(x, y): return ((x - 50) + (y - 50)) / math.sqrt(2)  # across the bar (+ toward lower-right)


def light(x, y):
    f = math.hypot(x - 42, y - 34) / 82
    if f < 0.22: return 1 - f / 0.22 * 0.15
    if f < 0.48: return 0.85 - (f - 0.22) / 0.26 * 0.5
    if f < 0.66: return 0.35 - (f - 0.48) / 0.18 * 0.27
    return 0.08


def dots():
    """(x, y, r) of every dot in the 100 box."""
    out = []
    for j in range(31):
        for i in range(31):
            x = PITCH / 2 + i * PITCH + (PITCH / 2 if j % 2 else 0); y = PITCH / 2 + j * PITCH * 0.866
            d = math.hypot(x - 50, y - 50); c = abs(across(x, y))
            if (25 <= d <= 37 and c > 11) or (c <= 5.6 and abs(along(x, y)) <= 46):
                out.append((x, y, 1.65 * math.sqrt(max(0.5, light(x, y)))))
    return out


def solid_polygons(steps=48):
    """The solid form as three polygons (two ring pieces and the bar), points in the 100 box."""
    pieces = []
    for turn in (0, 180):
        def arc(r, a, b):
            return [(50 + r * math.cos(math.radians(a + (b - a) * k / steps)), 50 + r * math.sin(math.radians(a + (b - a) * k / steps))) for k in range(steps + 1)]
        ao, ai = math.degrees(math.asin(CUT / R_OUT)), math.degrees(math.asin(CUT / R_IN))
        pieces.append(arc(R_OUT, turn + ao - 45, turn + 135 - ao) + arc(R_IN, turn + 135 - ai, turn + ai - 45))
    u, n = (1 / math.sqrt(2), -1 / math.sqrt(2)), (1 / math.sqrt(2), 1 / math.sqrt(2))
    pieces.append([(50 + s * HALF * u[0] + t * BAR * n[0], 50 + s * HALF * u[1] + t * BAR * n[1]) for s, t in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    return pieces


def solid_path(scale=1.0, ox=0.0, oy=0.0):
    """The solid form as an SVG path with arcs (also valid Android pathData and WPF geometry)."""
    f = lambda v: f"{round(v, 2):g}"
    pt = lambda r, deg: (ox + (50 + r * math.cos(math.radians(deg))) * scale, oy + (50 + r * math.sin(math.radians(deg))) * scale)
    ao, ai = math.degrees(math.asin(CUT / R_OUT)), math.degrees(math.asin(CUT / R_IN))
    out = ""
    for turn in (0, 180):
        (x1, y1), (x2, y2) = pt(R_OUT, turn + ao - 45), pt(R_OUT, turn + 135 - ao)
        (x3, y3), (x4, y4) = pt(R_IN, turn + 135 - ai), pt(R_IN, turn + ai - 45)
        ro, ri = f(R_OUT * scale), f(R_IN * scale)
        out += f"M{f(x1)},{f(y1)}A{ro},{ro} 0 0,1 {f(x2)},{f(y2)}L{f(x3)},{f(y3)}A{ri},{ri} 0 0,0 {f(x4)},{f(y4)}Z"
    bar = solid_polygons()[2]
    return out + "M" + "L".join(f"{f(ox + x * scale)},{f(oy + y * scale)}" for x, y in bar) + "Z"


def dots_path(scale=1.0, ox=0.0, oy=0.0):
    f = lambda v: f"{round(v, 2):g}"
    return "".join(f"M{f(ox + (x - r) * scale)},{f(oy + y * scale)}a{f(r * scale)},{f(r * scale)} 0 1,0 {f(2 * r * scale)},0a{f(r * scale)},{f(r * scale)} 0 1,0 -{f(2 * r * scale)},0z" for x, y, r in dots())


def draw(img, size, ox, oy, form):
    """Draws the mark (100 box scaled to `size`) at ox, oy with 4× supersampling."""
    k = 4
    big = Image.new("RGBA", (img.width * k, img.height * k), (0, 0, 0, 0)); d = ImageDraw.Draw(big)
    s = size / 100 * k
    if form == "dots":
        for x, y, r in dots():
            d.ellipse([ox * k + (x - r) * s, oy * k + (y - r) * s, ox * k + (x + r) * s, oy * k + (y + r) * s], fill=AMBER + (255,))
    else:
        for p in solid_polygons():
            d.polygon([(ox * k + x * s, oy * k + y * s) for x, y in p], fill=AMBER + (255,))
    img.alpha_composite(big.resize(img.size, Image.LANCZOS))


def glow(img, cx, cy, radius, strength=26):
    """A faint warm light on the tile from the upper left, as on the home page."""
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
    for k in range(40, 0, -1):
        r = radius * k / 40
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 214, 160, int(strength * (1 - k / 40) ** 1.5)))
    img.alpha_composite(layer)


def tile(size, inset, radius, form, mark_frac):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([inset, inset, size - 1 - inset, size - 1 - inset], radius=radius, fill=BG + (255,))
    if form == "dots": glow(img, size * 0.44, size * 0.38, size * 0.5)
    m = (size - 2 * inset) * mark_frac
    draw(img, m, (size - m) / 2, (size - m) / 2, form)
    return img


# iOS: full bleed, the system rounds the corners.
ios = Image.new("RGBA", (1024, 1024), BG + (255,)); glow(ios, 450, 390, 520)
draw(ios, 680, 172, 172, "dots")
ios.convert("RGB").save(f"{APPLE}/AppIcon-1024.png")
# macOS: the rounded tile sits inside the canvas (100…924), as Apple's grid asks; 64 and below use the solid form.
mac = tile(1024, 100, 185, "dots", 0.66)
for s in (128, 256, 512, 1024):
    mac.resize((s, s), Image.LANCZOS).save(f"{APPLE}/AppIcon-mac-{s}.png")
for s in (16, 32, 64):
    tile(s * 8, 100 * s * 8 // 1024, 185 * s * 8 // 1024, "solid", 0.7).resize((s, s), Image.LANCZOS).save(f"{APPLE}/AppIcon-mac-{s}.png")
# Windows: up to 64 (tray, title bar, taskbar) solid; 256 (Explorer, installer) dots.
sizes = [256, 64, 48, 32, 24, 16]
icons = [(tile(1024, 0, 200, "dots", 0.8) if s >= 128 else tile(s * 8, 0, s * 8 // 5, "solid", 0.86)).resize((s, s), Image.LANCZOS) for s in sizes]
icons[0].save("clients/windows/Veilbird/Assets/Veilbird.ico", sizes=[(s, s) for s in sizes], append_images=icons[1:])

with open("clients/android/app/src/main/res/drawable/ic_mark.xml", "w") as out:
    out.write(f"""<?xml version="1.0" encoding="utf-8"?>
<!-- TrackNothing mark (solid form) on its dark tile. Generated by scripts/brand-icons.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="48dp" android:height="48dp" android:viewportWidth="48" android:viewportHeight="48">
  <path android:fillColor="#FF1F1A15" android:pathData="M10,0h28a10,10 0,0 1,10 10v28a10,10 0,0 1,-10 10h-28a10,10 0,0 1,-10 -10v-28a10,10 0,0 1,10 -10z"/>
  <path android:fillColor="#FFE0A458" android:pathData="{solid_path(0.4, 4, 4)}"/>
</vector>
""")
with open("clients/android/app/src/main/res/drawable/ic_launcher_foreground.xml", "w") as out:
    out.write(f"""<?xml version="1.0" encoding="utf-8"?>
<!-- TrackNothing mark (dot form) without its tile, inside the 66dp adaptive-icon safe zone. Generated by scripts/brand-icons.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#E0A458" android:pathData="{dots_path(0.66, 21, 21)}"/>
</vector>
""")
with open("clients/android/app/src/main/res/drawable/ic_stat_mark.xml", "w") as out:
    out.write(f"""<?xml version="1.0" encoding="utf-8"?>
<!-- TrackNothing mark (solid form) for the status bar: white, the system tints it. Generated by scripts/brand-icons.py. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="{solid_path(0.26, -1, -1)}"/>
</vector>
""")
with open("public/favicon.svg", "w") as out:
    out.write(f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#110F0C"/>
  <path fill="#E0A458" d="{solid_path(0.56, 4, 4)}"/>
</svg>
""")
print("Icons written.")
