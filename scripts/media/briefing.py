#!/usr/bin/env python3
"""Render the HumanSI briefing-room media from the one original illustration.

scripts/build-media.sh drives this file and documents every output it makes.
Each subcommand also runs on its own:

  briefing.py stills  SRC OUTDIR             full image (jpg+webp) and the two comms portraits
  briefing.py frames  SRC SHAPE POSTER.png   raw rgb24 frames on stdout; frame 0 also saved as PNG
  briefing.py preview SRC SHAPE OUTDIR SEC.. single frames as PNG, for checking a look by eye
  briefing.py poster  POSTER.png OUTDIR SHAPE  poster PNG -> briefing-poster-SHAPE.{jpg,webp}
  briefing.py diff    A.png B.png            mean absolute difference (0-255) of two images
  briefing.py info    SHAPE                  "width height fps frames vp9-tile-columns"

SHAPE is 16x9 (1280x720) or 9x16 (720x1280). Needs Pillow and NumPy.

Why PIL and not an ffmpeg crop/zoompan expression: those filters place the
window on whole pixels, so a slow camera move stair-steps visibly (the classic
zoompan jitter). Image.resize(box=...) accepts a fractional source rectangle and
resamples it with Lanczos, so every frame lands with sub-pixel precision and the
move is smooth without a 4x upscaled intermediate.

Everything here is deterministic (fixed seeds, no clock, no OS randomness), so
re-running the build reproduces the same frames bit for bit.
"""

import math
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

FPS = 30            # 30, not 24: it maps 2:2 onto 60 Hz screens, so the pan has no pulldown judder
SECONDS = 14
FRAMES = FPS * SECONDS
# Fraction of each half of the loop the camera holds still at either end of
# its move (0.05 of 7 s, so about 0.7 s in total at the table and the same at
# the skylight, plus the ease on each side). The hold at the table is the
# "settle"; the hold at the skylight means the video opens on a still frame
# that matches its poster before the camera starts to move.
DWELL = 0.05

SRC_W, SRC_H = 896, 1200

# Where things are in the original (source pixels), read off the image itself.
SKYLIGHT = (445.0, 40.0)        # centre of the skylight opening at the top
HALO = (406.0, 268.0, 98.0)     # holographic halo around the captain's head: cx, cy, radius
# Comms crops: cx, cy, side. The captain's head runs from the top of the hair
# (y 222) to the beard (y 345), the visor spans x 372-462. The penguin's crest
# starts at y 432, its beak tip is at x 548 and its body spans x 455-560; it
# sits a little left of centre so the beak has room to look into.
CAPTAIN_FACE = (412, 289, 156)  # hair, visor and beard, a sliver of halo
NAVIGATOR = (510, 494, 150)     # the penguin's head and chest, the captain's hand under it

# Camera keyframes per shape. The window keeps the output aspect; "sky" is the
# opening frame under the skylight, "table" the frame the move settles on.
# Each is (centre x, window width, anchor, value): anchor "top"/"bottom" pins
# that edge of the window, "cy" pins its centre.
SHAPES = {
    # Landscape: a full-width 16:9 band that travels down the portrait image,
    # pushing in slightly as it reaches the table with the chalice and food.
    '16x9': {
        'size': (1280, 720),
        'sky': (448.0, 896.0, 'top', 0.0),
        'table': (440.0, 820.0, 'cy', 636.0),
        'drift': 0.6,
        'seed': 1609,
        'tiles': 2,         # log2 VP9 tile columns: 4 tiles across 1280 px
    },
    # Portrait: opens on the widest 9:16 window the image allows (675 px, the
    # full height, so the skylight sits at the top of the frame) and descends
    # as a push-in to a closer frame whose bottom edge rests on the floor, the
    # table in its lower half. A smaller sideways arc than landscape: on a
    # narrow phone frame a wide sway would read as the main move.
    '9x16': {
        'size': (720, 1280),
        'sky': (448.0, SRC_H * 720 / 1280, 'top', 0.0),
        'table': (444.0, 576.0, 'bottom', float(SRC_H)),
        'drift': 0.25,
        'seed': 916,
        'tiles': 1,         # 2 tiles across 720 px
    },
}


def die(msg):
    sys.stderr.write(f'briefing.py: {msg}\n')
    sys.exit(2)


# ---------------------------------------------------------------- timing ---

def travel(u):
    """Ping-pong 0 -> 1 -> 0 over one loop (u in [0, 1)), holding at both ends.

    Smootherstep has zero velocity *and* zero acceleration at both ends, so the
    camera eases out of the skylight hold, settles on the table, and eases back,
    and joins the holds without a bump. Because the move returns to where it
    started, the loop point falls inside the skylight hold: there is nothing
    to jump.
    """
    x = (u % 1.0) * 2.0
    if x > 1.0:
        x = 2.0 - x
    x = min(max((x - DWELL) / (1.0 - 2.0 * DWELL), 0.0), 1.0)
    return x * x * x * (x * (6.0 * x - 15.0) + 10.0)


def breath(u, cycles, phase=0.0):
    """0..1 raised cosine with a whole number of cycles per loop, so it loops."""
    return 0.5 - 0.5 * math.cos(2.0 * math.pi * (cycles * u) + phase)


# ---------------------------------------------------------------- camera ---

def _window(spec, out_w, out_h):
    cx, w, anchor, value = spec
    h = w * out_h / out_w
    if anchor == 'top':
        cy = value + h / 2.0
    elif anchor == 'bottom':
        cy = value - h / 2.0
    else:
        cy = value
    return cx, cy, w, h


def camera_box(shape, u):
    """Source rectangle (x0, y0, x1, y1), fractional, for loop position u."""
    cfg = SHAPES[shape]
    out_w, out_h = cfg['size']
    a = _window(cfg['sky'], out_w, out_h)
    b = _window(cfg['table'], out_w, out_h)
    p = travel(u)
    cx = a[0] + (b[0] - a[0]) * p
    cy = a[1] + (b[1] - a[1]) * p
    # Zoom geometrically so the push-in feels even, not front-loaded.
    w = a[2] * (b[2] / a[2]) ** p
    h = w * out_h / out_w
    # A gentle sideways arc: out to one side on the way down, the other side on
    # the way up, so the move reads as a crane rather than a mechanical tilt.
    # sin^3, not sin: its velocity is zero at u = 0 and 0.5 too, so the camera
    # really comes to rest on the table and at the loop point instead of
    # sliding sideways through them. Scaled by the free margin, so it can never
    # leave the image.
    margin = min(cx - w / 2.0, SRC_W - (cx + w / 2.0))
    cx += cfg['drift'] * max(margin, 0.0) * math.sin(2.0 * math.pi * u) ** 3
    box = (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)
    eps = 1e-6
    if box[0] < -eps or box[1] < -eps or box[2] > SRC_W + eps or box[3] > SRC_H + eps:
        die(f'camera leaves the image for {shape} at u={u:.4f}: {box}')
    return box


# ------------------------------------------------------------ light rigs ---

def _box(arr, r, axis):
    """Box blur of half-width r along an axis, edges extended (cumsum, O(n))."""
    pad = [(0, 0)] * arr.ndim
    pad[axis] = (r + 1, r)
    a = np.pad(arr, pad, mode='edge').cumsum(axis=axis, dtype=np.float64)
    n = arr.shape[axis]
    hi = np.take(a, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(a, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def _blur(arr, sigma):
    """Gaussian blur (three box passes) of a float32 HxW or HxWxC array.

    PIL's GaussianBlur does not take float images, and the light layers need
    float precision so their soft falloffs do not band.
    """
    # Width of each of three boxes whose combined variance matches sigma^2.
    r = max(int(round((math.sqrt(4.0 * sigma * sigma + 1.0) - 1.0) / 2.0)), 1)
    out = arr.astype(np.float32)
    for _ in range(3):
        out = _box(_box(out, r, 0), r, 1)
    return out


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


class Rig:
    """The source image plus the light layers that animate on top of it.

    Layers are stored pre-multiplied for a screen blend: screen(S, k*L) equals
    S + k*L*(1 - S), which is linear in k, so each frame is just S plus scaled
    layers, and the per-frame cost stays small.
    """

    def __init__(self, src_path):
        im = Image.open(src_path)
        im.load()
        if im.size != (SRC_W, SRC_H):
            die(f'expected a {SRC_W}x{SRC_H} source, got {im.size[0]}x{im.size[1]}')
        self.S = np.asarray(im.convert('RGB'), dtype=np.float32) / 255.0
        S = self.S
        Y = S[..., 0] * 0.2126 + S[..., 1] * 0.7152 + S[..., 2] * 0.0722
        yy, xx = np.mgrid[0:SRC_H, 0:SRC_W].astype(np.float32)
        inv = 1.0 - S

        # Skylight beam: the opening plus a cone of light widening downwards to
        # the captain's halo, fading with depth. Only pixels that are already
        # bright inside it bloom, so the glow follows the painted light rays.
        sx, sy = SKYLIGHT
        depth = np.clip((yy - 55.0) / 290.0, 0.0, 1.0)
        half = 150.0 + 95.0 * depth
        across = np.abs(xx - sx) / half
        beam = (1.0 - _smoothstep(0.55, 1.05, across)) * (1.0 - depth) ** 1.4
        beam = np.where(yy < 120.0, np.maximum(beam, 1.0 - _smoothstep(0.75, 1.15, np.abs(xx - sx) / 175.0)), beam)
        beam = _blur(beam.astype(np.float32), 18)
        self.beam = beam
        hot = _smoothstep(0.42, 0.92, Y) * beam
        warm = np.array([1.0, 0.86, 0.62], dtype=np.float32)
        bloom = _blur(hot, 10)[..., None] * warm + 0.6 * _blur(hot, 34)[..., None] * warm
        haze = beam[..., None] * warm * 0.55
        self.sky = (bloom * inv).astype(np.float32)
        self.haze = (haze * inv).astype(np.float32)

        # Shaft shimmer: an angular pattern seen from the skylight. Two slow
        # waves travelling in opposite directions make individual shafts swell
        # and fade in place instead of sweeping like a lighthouse.
        self.phi = np.arctan2(xx - sx, yy - (sy - 160.0)).astype(np.float32)

        # Halo: the bright ring lines and tick marks around the captain's head.
        # The lower sector is excluded because the white collar sits there.
        hx, hy, hr = HALO
        r = np.hypot(xx - hx, yy - hy)
        ring = _smoothstep(hr - 40.0, hr - 22.0, r) * (1.0 - _smoothstep(hr + 8.0, hr + 26.0, r))
        ang = np.degrees(np.arctan2(yy - hy, xx - hx))  # 90 = straight down
        ring *= 1.0 - (_smoothstep(25.0, 45.0, ang) * (1.0 - _smoothstep(135.0, 155.0, ang)))
        ring = _blur(ring.astype(np.float32), 3)
        halo_hot = _smoothstep(0.30, 0.75, Y) * ring
        halo = _blur(halo_hot[..., None] * S, 2.5) * 1.2 + _blur(halo_hot[..., None] * S, 9) * 0.9
        self.halo = (halo * inv).astype(np.float32)

        # Dust motes drifting in the light shafts: many fine specks plus a few
        # large soft ones, as if out of focus close to the lens. Positions,
        # paths and twinkle use whole-number cycle counts per loop, so every
        # mote is back where it started at the loop point. Seeded: the same
        # motes every build. They are lit by the cone, not by the blurred
        # beam, so they glint all the way down to the captain's head.
        depth2 = np.clip((yy - 40.0) / 340.0, 0.0, 1.0)
        self.cone = ((1.0 - _smoothstep(0.5, 1.0, across)) * (1.0 - _smoothstep(0.6, 1.0, depth2))).astype(np.float32)
        rng = np.random.default_rng(20240607)
        fine, soft = 120, 14
        n = fine + soft
        pts = []
        while len(pts) < n:
            x = rng.uniform(sx - 240.0, sx + 240.0)
            y = rng.uniform(60.0, 380.0)
            if self.cone[int(y), int(x)] > 0.3:
                pts.append((x, y))
        size = np.concatenate([rng.uniform(0.45, 1.0, fine), rng.uniform(2.6, 4.2, soft)])
        gain = np.concatenate([rng.uniform(0.35, 0.95, fine), rng.uniform(0.06, 0.13, soft)])
        self.motes = {
            'xy': np.array(pts, dtype=np.float32),
            'amp': rng.uniform(4.0, 16.0, (n, 2)).astype(np.float32),
            'cyc': rng.integers(1, 3, (n, 2)).astype(np.float32),
            'ph': rng.uniform(0.0, 2.0 * math.pi, (n, 3)).astype(np.float32),
            'tw': rng.integers(2, 5, n).astype(np.float32),
            'size': size.astype(np.float32),   # gaussian sigma in source px
            'gain': gain.astype(np.float32),
        }

    # Light levels over the loop. The skylight breathes three times per loop
    # (about 4.7 s per breath); the halo shimmers twice, offset in phase.
    @staticmethod
    def levels(u):
        b = breath(u, 3)
        return {
            'sky': 0.12 + 0.22 * b,
            'haze': 0.04 + 0.05 * b,
            'halo': 0.15 + 0.25 * breath(u, 2, 2.1),
        }

    def source_at(self, u, y0, y1, x0, x1):
        """Animated source (float, 0..1+) for the integer region [y0:y1, x0:x1]."""
        lv = self.levels(u)
        sl = (slice(y0, y1), slice(x0, x1))
        shimmer = 1.0 + 0.22 * np.sin(17.0 * self.phi[sl] + 2.0 * math.pi * u) \
            * np.sin(11.0 * self.phi[sl] - 2.0 * math.pi * 2.0 * u)
        out = self.S[sl] + lv['sky'] * self.sky[sl] * shimmer[..., None] \
            + lv['haze'] * self.haze[sl] * shimmer[..., None] + lv['halo'] * self.halo[sl]
        return out

    def motes_at(self, u):
        m = self.motes
        t = 2.0 * math.pi * u
        x = m['xy'][:, 0] + m['amp'][:, 0] * np.sin(m['cyc'][:, 0] * t + m['ph'][:, 0])
        y = m['xy'][:, 1] + m['amp'][:, 1] * np.sin(m['cyc'][:, 1] * t + m['ph'][:, 1])
        tw = 0.5 + 0.5 * np.sin(m['tw'] * t + m['ph'][:, 2])
        xi = np.clip(x.astype(int), 0, SRC_W - 1)
        yi = np.clip(y.astype(int), 0, SRC_H - 1)
        lit = self.cone[yi, xi]
        return x, y, m['size'], m['gain'] * (0.3 + 0.7 * tw) * lit


# ---------------------------------------------------------------- frames ---

_RIG = None
_CACHE = {}


def _vignette(w, h):
    key = ('vig', w, h)
    if key not in _CACHE:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        nx = (xx + 0.5) / w * 2.0 - 1.0
        ny = (yy + 0.5) / h * 2.0 - 1.0
        r = np.sqrt(nx * nx + ny * ny) / math.sqrt(2.0)
        _CACHE[key] = (1.0 - 0.42 * _smoothstep(0.38, 1.0, r))[..., None].astype(np.float32)
    return _CACHE[key]


def _resize_region(region, box, size):
    chans = []
    for c in range(3):
        im = Image.fromarray(np.ascontiguousarray(region[..., c]))
        chans.append(np.asarray(im.resize(size, Image.Resampling.LANCZOS, box=box), dtype=np.float32))
    return np.stack(chans, axis=-1)


def render_frame(shape, i, grain=True):
    """Frame i (0..FRAMES-1) of a shape as an HxWx3 uint8 array."""
    rig = _RIG
    cfg = SHAPES[shape]
    out_w, out_h = cfg['size']
    u = i / FRAMES

    # 180-degree shutter: average three camera positions across half a frame,
    # which turns the pan's per-frame steps into natural motion blur. In the
    # holds the three boxes coincide and this is a no-op.
    boxes = [camera_box(shape, u + d / FRAMES) for d in (-0.25, 0.0, 0.25)]
    pad = 5
    x0 = max(int(math.floor(min(b[0] for b in boxes))) - pad, 0)
    y0 = max(int(math.floor(min(b[1] for b in boxes))) - pad, 0)
    x1 = min(int(math.ceil(max(b[2] for b in boxes))) + pad, SRC_W)
    y1 = min(int(math.ceil(max(b[3] for b in boxes))) + pad, SRC_H)
    region = rig.source_at(u, y0, y1, x0, x1)
    acc = None
    for b in boxes:
        rel = (b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0)
        f = _resize_region(region, rel, (out_w, out_h))
        acc = f if acc is None else acc + f
    frame = acc / len(boxes)

    # Dust motes, splatted as tiny gaussians directly at output resolution so
    # they keep their sub-pixel positions (no snapping to the pixel grid).
    bx0, by0, bx1, by1 = boxes[1]
    scale = out_w / (bx1 - bx0)
    light = np.zeros((out_h, out_w), dtype=np.float32)
    mx, my, msz, mgain = rig.motes_at(u)
    for x, y, s, g in zip(mx, my, msz, mgain):
        if g < 0.01:
            continue
        X = (x - bx0) * scale - 0.5
        Y = (y - by0) * scale - 0.5
        sig = max(s * scale, 0.6)
        r = int(math.ceil(sig * 3.0))
        cx, cy = int(round(X)), int(round(Y))
        if cx + r < 0 or cy + r < 0 or cx - r >= out_w or cy - r >= out_h:
            continue
        xa, xb = max(cx - r, 0), min(cx + r + 1, out_w)
        ya, yb = max(cy - r, 0), min(cy + r + 1, out_h)
        gx = np.exp(-((np.arange(xa, xb, dtype=np.float32) - X) ** 2) / (2 * sig * sig))
        gy = np.exp(-((np.arange(ya, yb, dtype=np.float32) - Y) ** 2) / (2 * sig * sig))
        light[ya:yb, xa:xb] += g * np.outer(gy, gx)
    mote_col = np.array([1.0, 0.94, 0.82], dtype=np.float32)
    frame = frame + (light[..., None] * mote_col) * (1.0 - np.clip(frame, 0.0, 1.0))

    frame = frame * _vignette(out_w, out_h)

    if grain:
        # Fine monochrome grain, strongest in the midtones like film, softened
        # by a 3-tap blur so it reads as grain rather than digital noise.
        # Seeded per frame: different every frame, identical every build.
        rng = np.random.default_rng([cfg['seed'], i])
        n = rng.standard_normal((out_h + 2, out_w + 2), dtype=np.float32)
        n = (n[:-2] + 2.0 * n[1:-1] + n[2:]) * 0.25
        n = (n[:, :-2] + 2.0 * n[:, 1:-1] + n[:, 2:]) * 0.25
        lum = np.clip(frame[..., 0] * 0.2126 + frame[..., 1] * 0.7152 + frame[..., 2] * 0.0722, 0.0, 1.0)
        # About 2/255 rms in the midtones: enough to read as film and to dither
        # the soft glow gradients, little enough that the encoders' habit of
        # refreshing grain only on keyframes is not visible at the loop point.
        frame = frame + (0.020 * (0.35 + 2.6 * lum * (1.0 - lum)) * n)[..., None]

    return np.clip(frame * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8)


def _init(src):
    global _RIG
    _RIG = Rig(src)


def _work(job):
    shape, i = job
    return render_frame(shape, i).tobytes()


def cmd_frames(src, shape, poster):
    """Stream every frame as raw rgb24 on stdout; frame 0 is also the poster."""
    _init(src)
    first = render_frame(shape, 0)
    Image.fromarray(first).save(poster, optimize=False, compress_level=1)
    out = sys.stdout.buffer
    out.write(first.tobytes())
    jobs = [(shape, i) for i in range(1, FRAMES)]
    workers = max(1, min(4, os.cpu_count() or 1))
    try:
        if workers == 1:
            for job in jobs:
                out.write(_work(job))
        else:
            import multiprocessing as mp
            # fork: workers inherit the prepared rig instead of rebuilding it.
            with mp.get_context('fork').Pool(workers) as pool:
                for buf in pool.imap(_work, jobs, chunksize=4):
                    out.write(buf)
        out.flush()
    except BrokenPipeError:
        die('the encoder stopped reading frames')


def cmd_preview(src, shape, outdir, seconds):
    _init(src)
    os.makedirs(outdir, exist_ok=True)
    for s in seconds:
        i = int(round(float(s) * FPS)) % FRAMES
        path = os.path.join(outdir, f'preview-{shape}-{i:03d}.png')
        Image.fromarray(render_frame(shape, i)).save(path)
        print(path, camera_box(shape, i / FRAMES))


# ---------------------------------------------------------------- stills ---

def _square(im, spec, size=256):
    cx, cy, side = spec
    box = (cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2)
    if box[0] < 0 or box[1] < 0 or box[2] > SRC_W or box[3] > SRC_H:
        die(f'portrait crop leaves the image: {box}')
    out = im.resize((size, size), Image.Resampling.LANCZOS, box=box)
    # The crop is upscaled ~1.6x; a light unsharp mask restores edge crispness
    # without haloes at this size.
    return out.filter(ImageFilter.UnsharpMask(radius=1.2, percent=45, threshold=2))


def save_jpg(im, path):
    im.convert('RGB').save(path, 'JPEG', quality=82, progressive=True, optimize=True, subsampling='4:2:0')


def save_webp(im, path, quality=78):
    im.convert('RGB').save(path, 'WEBP', quality=quality, method=6)


def cmd_stills(src, outdir):
    im = Image.open(src)
    im.load()
    if im.size != (SRC_W, SRC_H):
        die(f'expected a {SRC_W}x{SRC_H} source, got {im.size[0]}x{im.size[1]}')
    im = im.convert('RGB')  # drops EXIF and other metadata from the copies
    save_jpg(im, os.path.join(outdir, 'crew-briefing.jpg'))
    save_webp(im, os.path.join(outdir, 'crew-briefing.webp'))
    save_webp(_square(im, CAPTAIN_FACE), os.path.join(outdir, 'comms-captain.webp'), quality=80)
    save_webp(_square(im, NAVIGATOR), os.path.join(outdir, 'comms-navigator.webp'), quality=80)


def cmd_poster(png, outdir, shape):
    im = Image.open(png)
    im.load()
    save_jpg(im, os.path.join(outdir, f'briefing-poster-{shape}.jpg'))
    save_webp(im, os.path.join(outdir, f'briefing-poster-{shape}.webp'))


def cmd_diff(a, b):
    A = np.asarray(Image.open(a).convert('RGB'), dtype=np.float32)
    B = np.asarray(Image.open(b).convert('RGB'), dtype=np.float32)
    if A.shape != B.shape:
        die(f'size mismatch {A.shape} vs {B.shape}')
    print(f'{np.abs(A - B).mean():.3f}')


def main(argv):
    if len(argv) < 2:
        die(__doc__.strip())
    cmd, args = argv[1], argv[2:]
    if cmd in ('frames', 'preview') and len(args) >= 2 and args[1] not in SHAPES:
        die(f'unknown shape {args[1]!r}; use one of {", ".join(SHAPES)}')
    if cmd == 'stills' and len(args) == 2:
        cmd_stills(*args)
    elif cmd == 'frames' and len(args) == 3:
        cmd_frames(*args)
    elif cmd == 'poster' and len(args) == 3:
        cmd_poster(*args)
    elif cmd == 'preview' and len(args) >= 4:
        cmd_preview(args[0], args[1], args[2], args[3:])
    elif cmd == 'diff' and len(args) == 2:
        cmd_diff(*args)
    elif cmd == 'info' and len(args) == 1 and args[0] in SHAPES:
        w, h = SHAPES[args[0]]['size']
        print(f'{w} {h} {FPS} {FRAMES} {SHAPES[args[0]]["tiles"]}')
    else:
        die(__doc__.strip())


if __name__ == '__main__':
    main(sys.argv)
