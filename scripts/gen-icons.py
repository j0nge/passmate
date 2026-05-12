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


def draw_basketball(size, padding_ratio=0.10, rounded=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background tile (rounded square)
    if rounded:
        radius = int(size * 0.22)
        draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=ORANGE)
    else:
        draw.rectangle((0, 0, size - 1, size - 1), fill=ORANGE)

    # Ball circle
    pad = int(size * padding_ratio)
    bx0, by0 = pad, pad
    bx1, by1 = size - pad, size - pad
    draw.ellipse((bx0, by0, bx1, by1), fill=BALL_FACE, outline=DARK, width=max(2, size // 100))

    cx = size / 2
    cy = size / 2
    r = (size - 2 * pad) / 2

    line_w = max(2, size // 90)

    # Horizontal seam (slight curve via arc)
    # Use thin arc that spans the ball width
    draw.arc((bx0, by0, bx1, by1), start=170, end=190, fill=DARK, width=line_w)  # left tip
    draw.arc((bx0, by0, bx1, by1), start=-10, end=10, fill=DARK, width=line_w)   # right tip
    # Middle horizontal line
    draw.line((bx0 + line_w * 2, cy, bx1 - line_w * 2, cy), fill=DARK, width=line_w)

    # Vertical seam
    draw.line((cx, by0 + line_w * 2, cx, by1 - line_w * 2), fill=DARK, width=line_w)

    # Two curved side seams - approximate by drawing two ellipses' arcs
    # Left curve: from top of ball to bottom, bulging right
    # Right curve: from top of ball to bottom, bulging left
    curve_w = int(r * 0.55)
    # Left seam (curve passing through top, bulging left)
    draw.arc(
        (cx - curve_w, by0, cx + curve_w, by1),
        start=90, end=270, fill=DARK, width=line_w,
    )

    return img


def export_icon(size, filename, rounded=True, padding_ratio=0.10):
    img = draw_basketball(size, padding_ratio=padding_ratio, rounded=rounded)
    img.save(filename, "PNG", optimize=True)
    print(f"wrote {filename} ({size}x{size})")


def export_maskable(size, filename):
    """Maskable: safe zone is inner 80%. We pad more so the ball stays in safe area
    no matter how the OS clips/rounds the icon."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Full-bleed orange (no rounded corners - OS will mask)
    draw.rectangle((0, 0, size - 1, size - 1), fill=ORANGE)

    # Ball drawn at smaller scale so it lives inside 80% safe zone
    inner = int(size * 0.6)  # ball diameter
    off = (size - inner) // 2
    bx0, by0 = off, off
    bx1, by1 = off + inner, off + inner
    draw.ellipse((bx0, by0, bx1, by1), fill=BALL_FACE, outline=DARK, width=max(2, size // 100))

    cx = size / 2
    cy = size / 2
    line_w = max(2, size // 90)

    draw.line((bx0 + line_w * 2, cy, bx1 - line_w * 2, cy), fill=DARK, width=line_w)
    draw.line((cx, by0 + line_w * 2, cx, by1 - line_w * 2), fill=DARK, width=line_w)
    curve_w = int(inner / 2 * 0.55)
    draw.arc(
        (cx - curve_w, by0, cx + curve_w, by1),
        start=90, end=270, fill=DARK, width=line_w,
    )

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
