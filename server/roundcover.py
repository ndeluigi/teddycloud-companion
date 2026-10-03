"""Round "coin" version of a story cover: a disc with a soft coloured ring on a transparent
background. Used for coins only; figurines keep their normal cover.

- cover with a transparent background (official product shots): the figurine is centred on a
  tinted disc (tint taken from the figurine's own colours)
- opaque cover: centre square, cropped to the disc
- cover that is already a disc on transparency: copied unchanged
"""
import colorsys
import shutil
from pathlib import Path

SIZE, DISC, RING = 640, 560, 14


def _disc(d):
    from PIL import Image, ImageDraw
    m = Image.new("L", (d * 4, d * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, d * 4 - 1, d * 4 - 1), fill=255)
    return m.resize((d, d), Image.LANCZOS)


def _tint(rgb_mean):
    h, _l, s = colorsys.rgb_to_hls(*[v / 255 for v in rgb_mean[:3]])
    base = tuple(int(v * 255) for v in colorsys.hls_to_rgb(h, 0.55, max(s, 0.55)))
    mix = lambda w: tuple(int(v + (255 - v) * w) for v in base)
    return mix(0.35), mix(0.78)          # ring, disc fill


def make_round(src: Path, dst: Path) -> bool:
    """Write the round version of src to dst (PNG). False if Pillow is missing or src unreadable."""
    try:
        from PIL import Image, ImageStat
    except ImportError:
        return False
    try:
        im = Image.open(src).convert("RGBA")
    except Exception:
        return False
    alpha = im.getchannel("A")
    w, h = im.size
    corners_clear = all(alpha.getpixel(p) < 16 for p in ((2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)))
    if corners_clear and alpha.getbbox():
        # already a disc? its opaque area fills ~pi/4 of a square bounding box
        bx0, by0, bx1, by1 = alpha.getbbox()
        bw, bh = bx1 - bx0, by1 - by0
        share = ImageStat.Stat(alpha.crop((bx0, by0, bx1, by1))).mean[0] / 255
        if abs(bw - bh) <= max(2, bw // 50) and 0.74 < share < 0.82:
            shutil.copyfile(src, dst)
            return True

    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    off = SIZE // 2 - DISC // 2
    ring_mask = Image.new("L", (SIZE, SIZE), 0)
    ring_mask.paste(_disc(DISC + 2 * RING), (off - RING, off - RING))

    if corners_clear:
        # cut-out figurine: centre it on a tinted disc. Horizontal centre = centre of mass (a tail
        # or an arm must not push the body aside), vertical centre = bounding box.
        solid = alpha.point(lambda v: 255 if v > 200 else 0)
        x0, y0, x1, y1 = solid.getbbox()
        ring, fill = _tint(ImageStat.Stat(im.crop((x0, y0, x1, y1)).convert("RGB"), solid.crop((x0, y0, x1, y1))).mean)
        col = solid.resize((w, 1), Image.BOX)                       # opaque share per column
        mass = list(col.getdata())
        cx = sum(i * v for i, v in enumerate(mass)) / max(1, sum(mass)) + 0.5
        cy = (y0 + y1) / 2
        k = min(DISC * 0.43 / max(cx - x0, x1 - cx), DISC * 0.43 / max(cy - y0, y1 - cy))
        full = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)   # whole picture: its shadow fades naturally
        inner = Image.new("RGBA", (DISC, DISC), fill + (255,))
        layer = Image.new("RGBA", (DISC, DISC), (0, 0, 0, 0))
        layer.paste(full, (int(DISC / 2 - cx * k), int(DISC / 2 - cy * k + DISC * 0.02)), full)
        inner.alpha_composite(layer)
    else:
        # opaque picture: centre square fills the disc
        s = min(w, h)
        sq = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
        rgb = sq.convert("RGB")
        ring, _fill = _tint(ImageStat.Stat(rgb).mean)
        white_bg = all(min(rgb.getpixel(p)) > 238 for p in ((2, 2), (s - 3, 2), (2, s - 3), (s - 3, s - 3)))
        if white_bg:
            # an object on white (e.g. a product card): keep it whole inside a white disc
            inner = Image.new("RGBA", (DISC, DISC), (255, 255, 255, 255))
            d = int(DISC * 0.80)
            inner.paste(sq.resize((d, d), Image.LANCZOS), ((DISC - d) // 2, (DISC - d) // 2))
        else:
            inner = sq.resize((DISC, DISC), Image.LANCZOS)

    out.paste(ring + (255,), (0, 0), ring_mask)
    inner.putalpha(_disc(DISC))
    out.alpha_composite(inner, (off, off))
    out.save(dst, "PNG")
    return True
