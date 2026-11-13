"""Draws the extension's icons in the digital look: a seven-segment "P" on a pale grey tile with a
thin edge, and its decimal point lit amber, like the Mac app's icon. At 48 and 128 px the unlit
segments show faintly, like a clock's "8"; at 16 and 32 px, where they would only blur, they're
left out and the segments are thicker.
Writes icon16/32/48/128.png into extension/icons. Pure Python, no image library needed.
Shapes are measured on a 16 x 16 grid and smoothed by sampling each pixel 5 x 5 times.

    python3 tools/make-icons.py
"""
import math, struct, zlib
from pathlib import Path

TILE, EDGE, INK, GHOST, AMBER, HALO = (237, 237, 233), (207, 207, 201), (12, 12, 12), (216, 216, 210), (245, 160, 0), (241, 222, 184)
SAMPLES = 5

def tile_depth(x, y):
    """How far inside the rounded tile (x, y) is, in grid units; negative means outside."""
    r, lo, hi = 3.6, 0.5, 15.5
    cx, cy = min(max(x, lo + r), hi - r), min(max(y, lo + r), hi - r)
    return r - math.hypot(x - cx, y - cy)

def digit(small):
    """The digit cell, in grid units: left, top, width, height, segment thickness, gap."""
    w, h = 6.0, 9.3
    return 0.5 + (15 - w) / 2 - 0.75, 0.5 + (15 - h) / 2, w, h, (1.75 if small else 1.3), 0.18

def in_horizontal(x, y, left, right, yc, t):
    return left <= x <= right and abs(y - yc) <= min(t / 2, x - left, right - x)

def in_vertical(x, y, xc, top, bottom, t):
    return top <= y <= bottom and abs(x - xc) <= min(t / 2, y - top, bottom - y)

def colour_at(x, y, small):
    """The colour of the mark at (x, y), or None where the tile shows."""
    x0, y0, w, h, t, gap = digit(small)
    top, mid, bottom = y0 + t / 2, y0 + h / 2, y0 + h - t / 2
    left, right = x0 + t / 2, x0 + w - t / 2
    hl, hr = x0 + gap + t / 2 - t / 2, x0 + w - gap - t / 2 + t / 2
    # The decimal point, amber, with a soft halo.
    px, py, r = x0 + w + t * 0.9, bottom + t * 0.05, t * 0.62
    d = math.hypot(x - px, y - py)
    if d <= r:
        return AMBER
    if d <= r * 1.7 and not small:
        return HALO
    segments = [
        (lambda: in_horizontal(x, y, hl, hr, top, t), True),                                  # a
        (lambda: in_vertical(x, y, right, top + gap, mid - gap, t), True),                   # b
        (lambda: in_vertical(x, y, right, mid + gap, bottom - gap, t), False),               # c
        (lambda: in_horizontal(x, y, hl, hr, bottom, t), False),                             # d
        (lambda: in_vertical(x, y, left, mid + gap, bottom - gap, t), True),                 # e
        (lambda: in_vertical(x, y, left, top + gap, mid - gap, t), True),                    # f
        (lambda: in_horizontal(x, y, hl, hr, mid, t), True),                                 # g
    ]
    for inside, lit in segments:
        if inside():
            if lit:
                return INK
            return None if small else GHOST
    return None

def pixel(px, py, size, small):
    acc = [0.0, 0.0, 0.0, 0.0]
    for sy in range(SAMPLES):
        for sx in range(SAMPLES):
            x = (px + (sx + 0.5) / SAMPLES) * 16 / size
            y = (py + (sy + 0.5) / SAMPLES) * 16 / size
            depth = tile_depth(x, y)
            if depth < 0:
                continue
            c = colour_at(x, y, small)
            if c is None:
                c = EDGE if depth < 16 / size else TILE
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
    n = SAMPLES * SAMPLES
    a = acc[3] / n
    if a == 0:
        return (0, 0, 0, 0)
    covered = acc[3] / 255
    return (round(acc[0] / covered), round(acc[1] / covered), round(acc[2] / covered), round(a))

def png(size, rows):
    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in rows)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

out = Path(__file__).resolve().parent.parent / "extension" / "icons"
for size in (16, 32, 48, 128):
    small = size < 48
    rows = [[pixel(x, y, size, small) for x in range(size)] for y in range(size)]
    (out / f"icon{size}.png").write_bytes(png(size, rows))
    print(f"icon{size}.png")
