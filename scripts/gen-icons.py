"""Generate Passmate app icons (PNG) for PWA / iOS A2HS.

Run from repo root:
    python3 scripts/gen-icons.py

Produces icon-192.png, icon-512.png, icon-maskable-512.png.
"""

from PIL import Image, ImageDraw
import math
import os

ORANGE = (255, 122, 24, 255)
DARK = (26, 16, 6, 255)
BALL_FACE = (224, 102, 24, 255)
BG_DARK = (15, 17, 21, 255)


def _seams(draw, cx, cy, r, line_w):
    """Draw the 4 standard basketball seams inside a circle centered at (cx, cy)."""
    bx0, by0 = cx - r, cy - r
    bx1, by1 = cx + r, cy + r
    pad_in = line_w  # don't poke through the outline

    # 1. Center horizontal seam
    draw.line(
        (bx0 + pad_in, cy, bx1 - pad_in, cy),
        fill=DARK, width=line_w,
    )

    # 2. Center vertical seam
    draw.line(
        (cx, by0 + pad_in, cx, by1 - pad_in),
        fill=DARK, width=line_w,
    )

    # 3 & 4. Two curved side seams — symmetric, bulging outward.
    # Each is the visible half of an ellipse. Pick the ellipse height so its
    # top/bottom tangents land ON the ball outline:
    #   ball:    (x-cx)^2 + (y-cy)^2 = r^2
    #   ellipse: ((x-side_cx)/r)^2 + ((y-cy)/h)^2 = 1
    # Top of ellipse is at (side_cx, cy - h). For that to be on the ball:
    #   (side_cx - cx)^2 + h^2 = r^2   =>   h = sqrt(r^2 - curve_rx^2)
    curve_rx = r * 0.55
    arc_h = math.sqrt(max(0.0, r * r - curve_rx * curve_rx))
    # tiny inward shave so the stroke itself doesn't cross the outline
    arc_h_eff = max(0.0, arc_h - line_w * 0.5)

    # Left seam: ellipse centered left of cx, drawing its RIGHT half
    left_cx = cx - curve_rx
    draw.arc(
        (left_cx - r, cy - arc_h_eff, left_cx + r, cy + arc_h_eff),
        start=-90, end=90, fill=DARK, width=line_w,
    )
    # Right seam: mirror, drawing LEFT half of ellipse centered right of cx
    right_cx = cx + curve_rx
    draw.arc(
        (right_cx - r, cy - arc_h_eff, right_cx + r, cy + arc_h_eff),
        start=90, end=270, fill=DARK, width=line_w,
    )


def draw_basketball(size, padding_ratio=0.10, rounded=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background tile (rounded square or full bleed)
    if rounded:
        radius = int(size * 0.22)
        draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=ORANGE)
    else:
        draw.rectangle((0, 0, size - 1, size - 1), fill=ORANGE)

    # Ball circle
    pad = int(size * padding_ratio)
    bx0, by0 = pad, pad
    bx1, by1 = size - pad, size - pad
    outline_w = max(2, size // 80)
    draw.ellipse((bx0, by0, bx1, by1), fill=BALL_FACE, outline=DARK, width=outline_w)

    cx = size / 2
    cy = size / 2
    r = (size - 2 * pad) / 2

    line_w = max(2, size // 90)
    _seams(draw, cx, cy, r, line_w)

    return img


def export_icon(size, filename, rounded=True, padding_ratio=0.10):
    img = draw_basketball(size, padding_ratio=padding_ratio, rounded=rounded)
    img.save(filename, "PNG", optimize=True)
    print(f"wrote {filename} ({size}x{size})")


def export_maskable(size, filename):
    """Maskable: safe zone is inner 80%. Ball lives inside 60% of canvas so
    any aggressive OS mask (circle / squircle / rounded square) still shows
    the whole ball."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Full-bleed orange (no rounded corners - OS will mask)
    draw.rectangle((0, 0, size - 1, size - 1), fill=ORANGE)

    inner = int(size * 0.6)
    off = (size - inner) // 2
    bx0, by0 = off, off
    bx1, by1 = off + inner, off + inner
    outline_w = max(2, size // 80)
    draw.ellipse((bx0, by0, bx1, by1), fill=BALL_FACE, outline=DARK, width=outline_w)

    cx = size / 2
    cy = size / 2
    r = inner / 2
    line_w = max(2, size // 90)
    _seams(draw, cx, cy, r, line_w)

    img.save(filename, "PNG", optimize=True)
    print(f"wrote {filename} ({size}x{size}) maskable")


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    export_icon(192, os.path.join(root, "icon-192.png"))
    export_icon(512, os.path.join(root, "icon-512.png"))
    # Apple touch icon: same as 192 but no rounded corners (iOS adds its own rounding)
    export_icon(180, os.path.join(root, "apple-touch-icon.png"), rounded=False, padding_ratio=0.08)
    export_maskable(512, os.path.join(root, "icon-maskable-512.png"))


if __name__ == "__main__":
    main()
