"""Lay a designed app screen into the green phone screens of a generated shot, frame by frame.
Needs Python 3 with numpy and opencv-python, and ffmpeg on PATH. Run it on ungraded cuts (assemble.mjs --no-grade):
grading first desaturates the green and the key fails. Generate the phones with solid bright green screens
(shot-list.mjs --svml asks for that on screen close-ups).
Green screens are found as bright, saturated, roughly rectangular green regions (so plants and green clothes are
left alone), keyed (a tapping finger stays in front) and filled with the screen image warped to their four corners.

  python3 tools/key-screen.py <in.mp4> <before.png> <after.png> <out.mp4> [--switch 0.55] [--mode closeup|all]
                       [--glow x0,y0,x1,y1]

--mode closeup tracks the single largest screen with temporal smoothing (phone close-ups); --mode all fills every
screen in each frame (phones held up in a wider shot). --switch is when the after-tap screen replaces the before
screen (fraction of the shot; 1 keeps the before screen). --glow removes green light the screen cast on a face
inside that box (fractions of the frame).
"""
import subprocess
import sys

import cv2
import numpy as np

src, before_path, after_path, out = sys.argv[1:5]
opt = lambda name, default: sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default
switch = float(opt("--switch", 0.55))
mode = opt("--mode", "closeup")
glow = [float(v) for v in opt("--glow", "").split(",")] if "--glow" in sys.argv else None
before, after = cv2.imread(before_path), cv2.imread(after_path)

cap = cv2.VideoCapture(src)
fps = cap.get(cv2.CAP_PROP_FPS)
frames = []
while True:
    ok, frame = cap.read()
    if not ok:
        break
    frames.append(frame)
cap.release()
h, w = frames[0].shape[:2]


def green_mask(frame):
    """Screen green: clearly greener than both red and blue, and bright (works for pale, glowing greens too)."""
    b, g, r = [c.astype(np.int16) for c in cv2.split(frame)]
    mask = (((g - np.maximum(r, b)) > 38) & (g > 120)).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))


def order(pts):
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)


def screens(mask, min_share):
    """Quads of every screen-like green region (rectangular enough, big enough), largest first."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    found = []
    for c in contours:
        hull = cv2.convexHull(c)
        area = cv2.contourArea(hull)
        if area < min_share * mask.size:
            continue
        (_, _), (rw, rh), _ = cv2.minAreaRect(hull)
        if rw * rh == 0 or area / (rw * rh) < 0.72:
            continue
        found.append((area, order(hull.reshape(-1, 2).astype(np.float32))))
    return [q for _, q in sorted(found, key=lambda x: -x[0])]


def fill(frame, mask, quad, ui):
    sh, sw = ui.shape[:2]
    matrix = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), quad)
    warped = cv2.warpPerspective(ui, matrix, (w, h), flags=cv2.INTER_AREA)
    inside = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inside, quad.astype(np.int32), 255)
    region = cv2.dilate(inside, np.ones((7, 7), np.uint8))
    alpha = cv2.GaussianBlur(cv2.dilate(mask & region, np.ones((3, 3), np.uint8)), (5, 5), 0).astype(np.float32)[..., None] / 255
    frame = (warped * alpha + frame * (1 - alpha)).astype(np.uint8)
    band = cv2.dilate(inside, np.ones((19, 19), np.uint8)) > 0
    b, g, r = [c.astype(np.int16) for c in cv2.split(frame)]  # int16: max(r, b) + 12 must not wrap past 255
    despilled = cv2.merge([b, np.minimum(g, np.maximum(r, b) + 12), r]).clip(0, 255).astype(np.uint8)
    return np.where(band[..., None], despilled, frame)


masks = [green_mask(f) for f in frames]
if mode == "closeup":
    quads = [(screens(m, 0.01) or [None])[0] for m in masks]
    areas = [cv2.contourArea(q) if q is not None else 0 for q in quads]
    typical = np.median([a for a in areas if a > 0]) if any(areas) else 0
    last = None  # a finger over a corner shrinks the region: reuse the last full one
    for i, q in enumerate(quads):
        if q is not None and areas[i] >= 0.88 * typical:
            last = q
        else:
            quads[i] = last
    per_frame, previous = [], None
    for q in quads:
        if q is not None and previous is not None:
            q = 0.6 * q + 0.4 * previous
        per_frame.append([q] if q is not None else [])
        previous = q if q is not None else previous
else:
    per_frame = [screens(m, 0.0012) for m in masks]

writer = subprocess.Popen(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                           "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "15", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
filled = 0
for i, (frame, mask, quads) in enumerate(zip(frames, masks, per_frame)):
    ui = after if i >= switch * len(frames) else before
    for quad in quads:
        frame = fill(frame, mask, quad, ui)
    filled += bool(quads)
    if glow:
        x0, y0, x1, y1 = int(glow[0] * w), int(glow[1] * h), int(glow[2] * w), int(glow[3] * h)
        box = frame[y0:y1, x0:x1].astype(np.int16)
        b, g, r = box[..., 0], box[..., 1], box[..., 2]
        # Green light on skin: skin keeps green near 0.68 of red with blue below green. Where green rose above 0.75 of
        # red (and blue stays well below green, which leaves lavender, white and leaves alone), pull it back.
        lit = (g > 0.75 * r) & (b < 0.8 * g) & (r > 60)
        target = np.where(lit, np.minimum(g, (0.7 * r).astype(np.int16)), g)
        weight = np.ones(g.shape, np.float32)
        ramp = max(4, min(g.shape) // 8)
        for axis in (0, 1):
            n = g.shape[axis]
            edge = np.minimum(np.arange(n), np.arange(n)[::-1]).clip(0, ramp) / ramp
            weight *= edge[:, None] if axis == 0 else edge[None, :]
        box[..., 1] = (g * (1 - weight) + target * weight).astype(np.int16)
        frame[y0:y1, x0:x1] = box.clip(0, 255).astype(np.uint8)
    writer.stdin.write(frame.tobytes())
writer.stdin.close()
writer.wait()
print(f"{out}: screens filled in {filled}/{len(frames)} frames ({mode})")
