"""Lay a designed app screen into the green phone screens of a generated shot, frame by frame.
Needs Python 3 with numpy and opencv-python, and ffmpeg on PATH. Run it on ungraded cuts (assemble.mjs --no-grade):
grading first desaturates the green and the key fails. Generate the phones with solid bright green screens
(shot-list.mjs --svml asks for that on screen close-ups).
Green screens are found as bright, saturated, roughly rectangular green regions (so plants and green clothes are
left alone), keyed (a tapping finger stays in front) and filled with the screen image warped to their four corners.

  python3 tools/key-screen.py <in.mp4> <before.png> <after.png> <out.mp4> [--mode track|closeup|all]
                       [--button x0,y0,x1,y1] [--switch 0.55] [--glow x0,y0,x1,y1]
  python3 tools/key-screen.py <still.png> <before.png> <after.png> <out.png> --mode still [--ref <first out.png>]
  python3 tools/key-screen.py <in.mp4> <before.png> <after.png> <out.mp4> --mode restore --ref <out.png> [--button ...]

--mode track (phone close-ups) tracks the phone as a plane: SIFT features on the bezel and case, matched to a frame
where the whole screen shows, give a RANSAC homography that places every corner even under a thumb; each edge is
then snapped to the visible green boundary, and the corner paths are smoothed. The UI is padded (not stretched) to
the screen's aspect and replaced additively: each pixel's screen share, from green dominance against a fitted model
of the plain screen, is swapped for the UI, so fingers, their motion blur and their shadows stay as filmed and the
plate's glow falloff and grain carry over. With --button (the button's box in the UI image) the screen flips to the
after state when a finger reaches the button zone, after three frames of a pressed button. --mode closeup is the
older per-frame corner fit; --mode all fills every screen in each frame (phones held up in a wider shot), also
additively. --switch is when the after-tap screen replaces the before
screen (fraction of the shot; 1 keeps the before screen). --glow removes green light the screen cast on a face
inside that box (fractions of the frame).

In-camera close-ups (the better route: the generator films the screen with its own light, reflections and finger
contact) use two more modes. --mode still puts the design on a generated still whose phone shows a plain white
screen and writes <out>.json with the screen corners; that still is the first frame of an image-to-video clip.
With --ref (an earlier --mode still output) the corners come from that still by a feature match: use it for a last
frame where a finger crosses the screen.
--mode restore then tracks the screen through the clip (matched to the still, then optical flow frame to frame with
a dense-alignment pull back to the still), measures the clip's own light on the screen, keeps fingers that reach in
from the screen edge, and lays the exact design back in so lettering the generator smudged is sharp again; with
--button it flips to the after screen on the tap. It writes <out>.json with the corners per frame and the tap frame.
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
    """Additive replacement into one screen: each pixel's screen share (from green dominance) is swapped for the
    UI, so fingers and their blurred edges stay as filmed."""
    sh, sw = ui.shape[:2]
    matrix = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), quad)
    warped = cv2.GaussianBlur(cv2.warpPerspective(ui, matrix, (w, h), flags=cv2.INTER_AREA).astype(np.float32), (0, 0), 0.5)
    inside = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inside, quad.astype(np.int32), 255)
    region = cv2.dilate(inside, np.ones((7, 7), np.uint8)) > 0
    f = frame.astype(np.float32)
    b, g, r = f[..., 0], f[..., 1], f[..., 2]
    gd = g - np.maximum(r, b)
    core = region & (gd > 45)
    if core.sum() < 20:
        return frame
    screen = f[core].mean(0)
    gd_screen = max(float(screen[1] - max(screen[0], screen[2])), 20)
    a = (np.clip((gd + 30) / (gd_screen + 30), 0, 1) * region)[..., None]
    return (f + a * (warped - screen)).clip(0, 255).astype(np.uint8)


def corners_from_region(mask):
    """Four corners (tl, tr, br, bl, ordered around the centre) of the largest green region."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = cv2.convexHull(max(contours, key=cv2.contourArea))
    quad = cv2.approxPolyDP(hull, 0.02 * cv2.arcLength(hull, True), True).reshape(-1, 2).astype(np.float32)
    if len(quad) != 4:
        quad = cv2.boxPoints(cv2.minAreaRect(hull)).astype(np.float32)
    centre = quad.mean(0)
    quad = quad[np.argsort(np.arctan2(quad[:, 1] - centre[1], quad[:, 0] - centre[0]))]  # clockwise from top-left-ish
    start = int(np.argmin(quad.sum(1)))
    return np.roll(quad, -start, axis=0)


def line_through(points):
    vx, vy, x0, y0 = cv2.fitLine(points.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return np.array([x0, y0]), np.array([vx, vy])


def intersect(l1, l2):
    (p, d), (q, e) = l1, l2
    m = np.array([[d[0], -e[0]], [d[1], -e[1]]])
    if abs(np.linalg.det(m)) < 1e-6:
        return None
    t = np.linalg.solve(m, q - p)[0]
    return p + t * d


def refine(quad, mask):
    """Snap each predicted edge to the visible green boundary; an edge a finger hides keeps its prediction."""
    edge = mask & ~cv2.erode(mask, np.ones((3, 3), np.uint8))
    ys, xs = np.nonzero(edge)
    pts = np.stack([xs, ys], 1).astype(np.float32)
    lines = []
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        d = (b - a) / (np.linalg.norm(b - a) + 1e-6)
        rel = pts - a
        along = rel @ d
        across = np.abs(rel[:, 0] * d[1] - rel[:, 1] * d[0])
        near = pts[(across < 6) & (along > 0.1 * np.linalg.norm(b - a)) & (along < 0.9 * np.linalg.norm(b - a))]
        lines.append(line_through(near) if len(near) >= 25 else (a, d))
    out = [intersect(lines[i - 1], lines[i]) for i in range(4)]
    if any(c is None for c in out):
        return quad
    out = np.array(out, np.float32)
    return out if np.abs(out - quad).max() < 18 else quad


def track_quads(masks):
    """Screen corners in every frame: SIFT features on the phone body (bezel and case) matched to a clean reference
    frame give a homography (RANSAC), which places the whole screen even where fingers cover it; each edge is then
    snapped to the visible green boundary and the corner paths are lightly smoothed."""
    areas = [int((m > 0).sum()) for m in masks]
    ref = int(np.argmax(areas))
    quad_ref = corners_from_region(masks[ref])
    body = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(body, quad_ref.astype(np.int32), 255)
    ring = cv2.dilate(body, np.ones((61, 61), np.uint8)) & ~cv2.erode(body, np.ones((9, 9), np.uint8))
    sift, matcher = cv2.SIFT_create(2000), cv2.BFMatcher()
    gray = lambda f: cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    kr, dr = sift.detectAndCompute(gray(frames[ref]), ring)
    quads, previous, tracked = [], quad_ref, 0
    for f, m in zip(frames, masks):
        predicted = previous
        k, d = sift.detectAndCompute(gray(f), None)
        if dr is not None and d is not None and len(k) >= 8:
            good = [p[0] for p in matcher.knnMatch(dr, d, k=2) if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
            if len(good) >= 8:
                H, inl = cv2.findHomography(np.float32([kr[g.queryIdx].pt for g in good]), np.float32([k[g.trainIdx].pt for g in good]), cv2.RANSAC, 3.0)
                if H is not None and inl.sum() >= 8:
                    predicted = cv2.perspectiveTransform(quad_ref.reshape(-1, 1, 2), H).reshape(-1, 2)
                    tracked += 1
        quad = refine(predicted, m) if m.any() else predicted
        quads.append(quad)
        previous = quad
    quads = np.array(quads)
    smooth = quads.copy()
    for i in range(1, len(quads) - 1):  # centred 3-frame average removes edge-fit jitter
        smooth[i] = (quads[i - 1] + 2 * quads[i] + quads[i + 1]) / 4
    return list(smooth), tracked, ref


def screen_model(frame, quad, size=(60, 120)):
    """The plain screen's own colour as a smooth field: a quadratic fit (per channel) over pixels that are clearly
    screen green, in the screen's rectified coordinates. Fingers are whatever departs from it."""
    sw, sh = size
    H = cv2.getPerspectiveTransform(quad, np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]))
    flat = cv2.warpPerspective(frame, H, (sw, sh)).reshape(-1, 3).astype(np.float32)
    yy, xx = np.mgrid[0:sh, 0:sw]
    X = np.stack([np.ones(sw * sh), xx.ravel() / sw, yy.ravel() / sh, (xx.ravel() / sw) ** 2, (yy.ravel() / sh) ** 2, xx.ravel() * yy.ravel() / (sw * sh)], 1)
    b, g, r = flat[:, 0], flat[:, 1], flat[:, 2]
    keep = (g - np.maximum(r, b)) > 45
    if keep.sum() < 50:
        return None, None
    coef, *_ = np.linalg.lstsq(X[keep], flat[keep], rcond=None)
    model = (X @ coef).reshape(sh, sw, 3)
    noise = float(np.std(flat[keep] - (X @ coef)[keep]))
    Hinv = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), quad)
    return cv2.warpPerspective(model, Hinv, (w, h), flags=cv2.INTER_LINEAR), noise


def fit_aspect(ui, quad):
    """Pad the screen design (edge pixels repeated) to the phone screen's own aspect instead of stretching it."""
    width = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
    height = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
    target, sh, sw = width / height, ui.shape[0], ui.shape[1]
    if target > sw / sh:
        pad = int(round((target * sh - sw) / 2))
        return cv2.copyMakeBorder(ui, 0, 0, pad, pad, cv2.BORDER_REPLICATE), (pad, 0)
    pad = int(round((sw / target - sh) / 2))
    return cv2.copyMakeBorder(ui, pad, pad, 0, 0, cv2.BORDER_REPLICATE), (0, pad)


def finish_screen(ui):
    """Glass: a faint diagonal reflection and rounded corners (as an alpha channel)."""
    sh, sw = ui.shape[:2]
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    band = np.clip(1 - np.abs((xx / sw + yy / sh) - 0.55) / 0.18, 0, 1) * 0.07
    glass = ui.astype(np.float32) * (1 - band[..., None]) + 255 * band[..., None]
    alpha = np.zeros((sh, sw), np.uint8)
    r = int(0.07 * sw)
    cv2.rectangle(alpha, (r, 0), (sw - r, sh), 255, -1)
    cv2.rectangle(alpha, (0, r), (sw, sh - r), 255, -1)
    for cx, cy in ((r, r), (sw - r, r), (r, sh - r), (sw - r, sh - r)):
        cv2.circle(alpha, (cx, cy), r, 255, -1, cv2.LINE_AA)
    return glass, alpha.astype(np.float32) / 255


def motion_blur(img, velocity):
    length = float(np.linalg.norm(velocity)) * 0.5  # a half-open shutter
    if length < 1.5:
        return img
    k = int(min(15, round(length))) | 1
    kernel = np.zeros((k, k), np.float32)
    angle = np.degrees(np.arctan2(velocity[1], velocity[0]))
    cv2.line(kernel, (0, k // 2), (k - 1, k // 2), 1, 1)
    kernel = cv2.warpAffine(kernel, cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), angle, 1), (k, k))
    return cv2.filter2D(img, -1, kernel / max(kernel.sum(), 1e-6))


def white_quad(frame):
    """Corners of the largest bright, colourless, roughly rectangular region: a plain glowing phone screen."""
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = ((hsv[..., 2] > 200) & (hsv[..., 1] < 45)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return corners_from_region(mask), mask


def smooth_field(img, quad, keep, size=(60, 120)):
    """A smooth (quadratic, per channel) fit of img over the quad, from the pixels keep marks, mapped back to the frame."""
    sw, sh = size
    H = cv2.getPerspectiveTransform(quad, np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]))
    flat = cv2.warpPerspective(img, H, (sw, sh)).reshape(-1, 3).astype(np.float32)
    k = cv2.warpPerspective(keep.astype(np.uint8), H, (sw, sh), flags=cv2.INTER_NEAREST).ravel() > 0
    yy, xx = np.mgrid[0:sh, 0:sw]
    X = np.stack([np.ones(sw * sh), xx.ravel() / sw, yy.ravel() / sh, (xx.ravel() / sw) ** 2, (yy.ravel() / sh) ** 2, xx.ravel() * yy.ravel() / (sw * sh)], 1)
    coef, *_ = np.linalg.lstsq(X[k], flat[k], rcond=None)
    Hinv = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), quad)
    return cv2.warpPerspective((X @ coef).reshape(sh, sw, 3).astype(np.float32), Hinv, (frame_w(img), frame_h(img)), flags=cv2.INTER_LINEAR)


frame_w = lambda img: img.shape[1]
frame_h = lambda img: img.shape[0]


def border_components(occluded, quad, band=8, min_share=0.03):
    """Keep only occluding blobs that reach the screen's edge and are finger-sized (at least min_share of the
    screen): fingers come in from outside, while a generator's smudged text sits inside the screen, or is a small
    word near its edge, and should be restored, not kept."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(occluded.astype(np.uint8), np.ones((5, 5), np.uint8)))
    edge = np.zeros(occluded.shape, np.uint8)
    cv2.polylines(edge, [quad.astype(np.int32)], True, 1, band * 2)
    min_area = min_share * cv2.contourArea(quad.astype(np.float32))
    touching = [l for l in np.unique(labels[(edge > 0) & (labels > 0)]) if stats[l, cv2.CC_STAT_AREA] >= min_area]
    return np.isin(labels, touching) & occluded


if mode == "still":
    # A generated still with a plain white screen: put the design on it. Writes <out> as an image and <out>.json
    # with the screen corners (tl, tr, br, bl) for --mode restore.
    import json
    frame = cv2.imread(src)
    h, w = frame.shape[:2]
    quad, mask = white_quad(frame)
    if "--ref" in sys.argv:
        # A second still of the same phone (say, a finger pressing it): carry the first still's corners over by a
        # feature match on the phone and hands, since a finger across the screen edge breaks the region's outline.
        ref_path = opt("--ref", None)
        ref, ref_quad = cv2.imread(ref_path), np.float32(json.load(open(ref_path + ".json"))["quad"])
        around = np.zeros(ref.shape[:2], np.uint8)
        cv2.fillConvexPoly(around, ref_quad.astype(np.int32), 255)
        ring = cv2.dilate(around, np.ones((121, 121), np.uint8)) & ~cv2.erode(around, np.ones((9, 9), np.uint8))
        sift, matcher = cv2.SIFT_create(4000), cv2.BFMatcher()
        kr, dr = sift.detectAndCompute(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY), ring)
        k, d = sift.detectAndCompute(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), None)
        good = [p[0] for p in matcher.knnMatch(dr, d, k=2) if len(p) == 2 and p[0].distance < 0.75 * p[1].distance] if dr is not None and d is not None else []
        H, inl = cv2.findHomography(np.float32([kr[g.queryIdx].pt for g in good]), np.float32([k[g.trainIdx].pt for g in good]), cv2.RANSAC, 3.0) if len(good) >= 12 else (None, None)
        if H is None or inl.sum() < 12:
            sys.exit(f"{src}: could not match the phone to {ref_path} ({len(good)} matches); regenerate the still closer to it")
        quad = refine(cv2.perspectiveTransform(ref_quad.reshape(-1, 1, 2), H).reshape(-1, 2).astype(np.float32), mask)
    ui, _ = fit_aspect(before, quad)
    sh, sw = ui.shape[:2]
    Hm = cv2.getPerspectiveTransform(np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]]), quad)
    warped = cv2.warpPerspective(ui.astype(np.float32), Hm, (w, h), flags=cv2.INTER_AREA)
    inside = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(inside, quad.astype(np.int32), 255)
    inside = cv2.erode(inside, np.ones((3, 3), np.uint8))
    white = smooth_field(frame, quad, (mask > 0) & (inside > 0))
    dist = np.linalg.norm(frame.astype(np.float32) - white, axis=2)
    finger = border_components(dist > 40, quad)
    a = (inside > 0).astype(np.float32) * (1 - np.clip((dist - 25) / 30, 0, 1) * cv2.dilate(finger.astype(np.uint8), np.ones((5, 5), np.uint8)))
    a = cv2.GaussianBlur(a, (3, 3), 0)[..., None]
    # The screen keeps the generated light (its white field, normalised) over the design.
    light = np.clip(white / max(white[inside > 0].mean(), 1), 0.85, 1.1)
    result = frame * (1 - a) + cv2.GaussianBlur(warped * light, (0, 0), 0.7) * a
    cv2.imwrite(out, result.clip(0, 255).astype(np.uint8))
    json.dump({"quad": quad.tolist(), "size": [w, h]}, open(out + ".json", "w"))
    print(f"{out}: screen at {np.round(quad).astype(int).tolist()}")
    sys.exit(0)

if mode == "restore":
    # A generated clip whose screen already shows the design (it started from a --mode still frame): track the
    # screen against that still, take the clip's own light on the screen, and lay the exact design back in so any
    # smudged lettering is sharp again; switch to the after state when a finger reaches --button.
    import json
    ref_path = opt("--ref", None)
    ref = cv2.imread(ref_path)
    meta = json.load(open(ref_path + ".json"))
    sx, sy = w / meta["size"][0], h / meta["size"][1]
    ref = cv2.resize(ref, (w, h), interpolation=cv2.INTER_AREA)
    ref_quad = (np.float32(meta["quad"]) * [sx, sy]).astype(np.float32)
    button = [float(v) for v in opt("--button", "").split(",")] if "--button" in sys.argv else None
    sift, matcher = cv2.SIFT_create(4000), cv2.BFMatcher()
    gray = lambda f: cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
    area = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(area, ref_quad.astype(np.int32), 255)
    area = cv2.dilate(area, np.ones((81, 81), np.uint8))
    kr, dr = sift.detectAndCompute(gray(ref), area)
    # Track: the first frame is matched to the reference still (features, then dense ECC alignment); every later
    # frame follows the one before it by optical flow on the phone, its case and the hand holding it (both frames
    # equally soft, so smudged lettering does not matter), and a small ECC pull towards the reference stops drift.
    soft = lambda img: cv2.GaussianBlur(gray(img).astype(np.float32) / 255, (0, 0), 3)
    ref_soft = soft(ref)
    diagonal = float(np.linalg.norm(ref_quad[2] - ref_quad[0]))
    corners_of = lambda H: cv2.perspectiveTransform(ref_quad.reshape(-1, 1, 2), H).reshape(-1, 2)

    def ecc(f, H, limit):
        """Refine H (reference to frame) by dense alignment; keep it only if it moves the corners less than limit."""
        mask = cv2.warpPerspective(area, H, (w, h), flags=cv2.INTER_NEAREST)
        try:
            _, H_t = cv2.findTransformECC(ref_soft, soft(f), H.astype(np.float32).copy(), cv2.MOTION_HOMOGRAPHY,
                                          (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), mask, 5)
        except cv2.error:
            return H
        return H_t if np.abs(corners_of(H_t) - corners_of(H)).max() < limit else H

    H = np.eye(3, dtype=np.float32)
    k, d = sift.detectAndCompute(gray(frames[0]), None)
    if d is not None and dr is not None:
        good = [p[0] for p in matcher.knnMatch(dr, d, k=2) if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
        if len(good) >= 20:
            H0, inl = cv2.findHomography(np.float32([kr[g.queryIdx].pt for g in good]), np.float32([k[g.trainIdx].pt for g in good]), cv2.RANSAC, 3.0)
            if H0 is not None and inl.sum() >= 20:
                H = H0.astype(np.float32)
    H = ecc(frames[0], H, 0.05 * diagonal)
    quads, flowed = [corners_of(H)], 0
    for prev, f in zip(frames, frames[1:]):
        g0, g1 = gray(prev), gray(f)
        region = cv2.warpPerspective(area, H, (w, h), flags=cv2.INTER_NEAREST)
        pts = cv2.goodFeaturesToTrack(g0, 800, 0.005, 6, mask=region)
        if pts is not None and len(pts) >= 12:
            nxt, ok, _ = cv2.calcOpticalFlowPyrLK(g0, g1, pts, None, winSize=(21, 21), maxLevel=4)
            back, ok2, _ = cv2.calcOpticalFlowPyrLK(g1, g0, nxt, None, winSize=(21, 21), maxLevel=4)
            keep = (ok.ravel() == 1) & (ok2.ravel() == 1) & (np.linalg.norm((back - pts).reshape(-1, 2), axis=1) < 0.7)
            if keep.sum() >= 12:
                step, inl = cv2.findHomography(pts[keep], nxt[keep], cv2.RANSAC, 1.5)
                if step is not None and inl.sum() >= 12:
                    H = (step @ H).astype(np.float32)
                    flowed += 1
        H = ecc(f, H, 0.012 * diagonal)
        quads.append(corners_of(H))
    quads = np.array(quads)
    for i in range(1, len(quads) - 1):
        quads[i] = (quads[i - 1] + 2 * quads[i] + quads[i + 1]) / 4
    track_quad, track_quads = ref_quad.copy(), quads.copy()  # still-to-frame mapping, for the clean screen plate
    designs = {}
    for name, img in (("before", before), ("after", after)):
        designs[name], offset = fit_aspect(img, ref_quad)
    # Snap the corners to where the design really sits in the reference frame (feature match, design to frame).
    kd, dd = sift.detectAndCompute(cv2.cvtColor(designs["before"], cv2.COLOR_BGR2GRAY), None)
    if dd is not None and dr is not None:
        good = [p[0] for p in matcher.knnMatch(dd, dr, k=2) if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
        if len(good) >= 15:
            H, inl = cv2.findHomography(np.float32([kd[g.queryIdx].pt for g in good]), np.float32([kr[g.trainIdx].pt for g in good]), cv2.RANSAC, 2.0)
            if H is not None and inl.sum() >= 15:
                dh, dw = designs["before"].shape[:2]
                snapped = cv2.perspectiveTransform(np.float32([[[0, 0]], [[dw, 0]], [[dw, dh]], [[0, dh]]]), H).reshape(-1, 2)
                if np.abs(snapped - ref_quad).max() < 0.08 * np.linalg.norm(ref_quad[2] - ref_quad[0]):
                    shift = snapped - ref_quad
                    ref_quad = snapped
                    quads = quads + shift  # every tracked frame moves with the reference
    pressed = designs["before"].copy()
    if button:
        x0, y0, x1, y1 = [int(v) for v in (button[0] + offset[0], button[1] + offset[1], button[2] + offset[0], button[3] + offset[1])]
        pressed[y0:y1, x0:x1] = (pressed[y0:y1, x0:x1] * 0.8).astype(np.uint8)
    designs["pressed"] = pressed
    sh, sw = designs["before"].shape[:2]
    src_corners = np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]])
    plans, contact, covers = [], None, []
    debug = subprocess.Popen(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                              "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", out + ".alpha.mp4"],
                             stdin=subprocess.PIPE) if "--debug" in sys.argv else None
    after_debug = sys.argv[sys.argv.index("--debug") + 1:][:1] if debug else []
    debug_frame = int(after_debug[0]) if after_debug and after_debug[0].isdigit() else None  # --debug N: also N's images
    for i, (f, q) in enumerate(zip(frames, quads)):
        Hm = cv2.getPerspectiveTransform(src_corners, q)
        expected = cv2.warpPerspective(designs["before"].astype(np.float32), Hm, (w, h), flags=cv2.INTER_AREA)
        # The clean plate: the still's screen (the generator's own rendering, no finger) carried into this frame.
        clean = cv2.warpPerspective(ref.astype(np.float32), cv2.getPerspectiveTransform(track_quad, track_quads[i]), (w, h), flags=cv2.INTER_LINEAR)
        inside = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(inside, q.astype(np.int32), 255)
        inside = cv2.erode(inside, np.ones((3, 3), np.uint8)) > 0
        f32 = f.astype(np.float32)
        sigma = max(6.0, 0.04 * np.linalg.norm(q[2] - q[0]))

        def ratio(img, base, keep):
            """Light: img over base, both heavily blurred inside keep (the glow's shape and colour, not lettering)."""
            weight = np.maximum(cv2.GaussianBlur(keep.astype(np.float32), (0, 0), sigma), 1e-3)[..., None]
            soft_ = lambda x: cv2.GaussianBlur(x * keep[..., None], (0, 0), sigma) / weight
            return np.clip(soft_(img) / np.maximum(soft_(base), 1), 0.6, 1.4)

        # Fingers: what departs from the clean plate (relit to this frame), in blobs that reach in from the edge.
        # A second pass measures the light without the finger, so the finger's own colour does not leak into it.
        clear = inside
        for _ in range(2):
            diff = np.linalg.norm(cv2.GaussianBlur(f32, (0, 0), 2) - cv2.GaussianBlur(clean * ratio(f32, clean, clear), (0, 0), 2), axis=2)
            finger = border_components((diff > 40) & inside, q, min_share=0.008)
            clear = inside & ~cv2.dilate(finger.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
            if clear.sum() < 0.3 * inside.sum():
                clear = inside
                break
        light = ratio(f32, expected, clear)
        # Where the finger crosses a button of nearly its own colour, the difference alone misses part of it: near the
        # finger, a pixel closer to the finger's own (measured) colour than to the clean screen is finger too.
        sure = finger & (diff > 80)
        if sure.sum() > 200:
            skin = np.median(f32[sure], axis=0)
            near = cv2.dilate(finger.astype(np.uint8), np.ones((25, 25), np.uint8)).astype(bool) & inside
            to_skin = np.linalg.norm(f32 - skin, axis=2)
            to_screen = np.linalg.norm(f32 - clean * ratio(f32, clean, clear), axis=2)
            finger = finger | (near & (to_skin < 60) & (to_skin < 0.6 * to_screen))
            # ...and a changed patch that is still nearer the screen's colour than the finger's (the generator's own
            # button press, a smudged word) is screen, not finger.
            finger &= ~((to_screen < to_skin) & (to_skin > 60))
        # The finger is solid: its outline is soft (motion blur, anti-aliasing), its inside is never see-through. A
        # finger's highlight can match a white screen, leaving only its edges and tip; the convex hull of each group
        # of finger pieces fills it back in.
        finger = border_components(finger & inside, q, min_share=0.008)
        solid = np.zeros((h, w), np.uint8)
        count, groups = cv2.connectedComponents(cv2.dilate(finger.astype(np.uint8), np.ones((25, 25), np.uint8)))
        for g in range(1, count):
            ys, xs = np.nonzero(finger & (groups == g))
            if len(xs) >= 3:
                cv2.fillConvexPoly(solid, cv2.convexHull(np.stack([xs, ys], 1).astype(np.int32)), 1)
        solid &= inside.astype(np.uint8)
        occ = np.maximum(np.clip((diff - 25) / 30, 0, 1) * cv2.dilate(finger.astype(np.uint8), np.ones((7, 7), np.uint8)),
                         cv2.erode(solid, np.ones((5, 5), np.uint8)).astype(np.float32))
        a = cv2.GaussianBlur(inside.astype(np.float32) * (1 - occ), (3, 3), 0)
        if button:
            box = np.zeros((h, w), np.uint8)
            cv2.fillConvexPoly(box, cv2.perspectiveTransform(np.float32([[[x0, y0]], [[x1, y0]], [[x1, y1]], [[x0, y1]]]), Hm).astype(np.int32), 1)
            covers.append(round(float(((a < 0.5) & (box > 0)).sum() / max(box.sum(), 1)), 4))
        if debug:
            debug.stdin.write(np.repeat((a * 255).astype(np.uint8)[..., None], 3, 2).tobytes())
            if i == debug_frame:
                cv2.imwrite(out + f".{i}.png", np.hstack([f, clean.clip(0, 255).astype(np.uint8), np.repeat(np.clip(diff * 2, 0, 255).astype(np.uint8)[..., None], 3, 2)]))
        plans.append((Hm, light, a))
    if debug:
        debug.stdin.close()
        debug.wait()
    # The tap: the first frame the finger covers a tenth of the button and is near its deepest cover of the next
    # few frames (it has landed, not just passing on its way in).
    contact = next((i for i, c in enumerate(covers) if c >= 0.10 and c >= 0.6 * max(covers[i:i + 7])), len(frames))
    writer = subprocess.Popen(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                               "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "15", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i, (f, (Hm, light, a)) in enumerate(zip(frames, plans)):
        state = "before" if i < contact else "pressed" if i < contact + 3 else "after"
        design = cv2.warpPerspective(designs[state].astype(np.float32), Hm, (w, h), flags=cv2.INTER_AREA)
        design = cv2.GaussianBlur(design * light, (0, 0), 0.6)
        a3 = a[..., None]
        writer.stdin.write((f * (1 - a3) + design * a3).clip(0, 255).astype(np.uint8).tobytes())
    writer.stdin.close()
    writer.wait()
    json.dump({"quads": np.round(quads, 2).tolist(), "tap": contact, "frames": len(frames), "fps": fps, "buttonCover": covers},
              open(out + ".json", "w"))
    print(f"{out}: restored the design in {len(frames)} frames (optical flow on {flowed} of {len(frames) - 1} steps); "
          f"tap at frame {contact} (restore)")
    sys.exit(0)

masks = [green_mask(f) for f in frames]
if mode == "track":
    button = [float(v) for v in opt("--button", "").split(",")] if "--button" in sys.argv else None
    quads, tracked, ref = track_quads(masks)
    screens_fit = [fit_aspect(img, quads[ref]) for img in (before, after)]
    (before_fit, offset), (after_fit, _) = screens_fit
    # Pressed state: the button darkens for the three frames of the tap.
    pressed = before_fit.copy()
    if button:
        x0, y0, x1, y1 = [int(v) for v in (button[0] + offset[0], button[1] + offset[1], button[2] + offset[0], button[3] + offset[1])]
        pressed[y0:y1, x0:x1] = (pressed[y0:y1, x0:x1] * 0.78).astype(np.uint8)
    looks = {name: finish_screen(img) for name, img in (("before", before_fit), ("pressed", pressed), ("after", after_fit))}
    sh, sw = before_fit.shape[:2]
    src_corners = np.float32([[0, 0], [sw, 0], [sw, sh], [0, sh]])
    rendered, alphas, contact = [], [], None
    for i, (frame, quad) in enumerate(zip(frames, quads)):
        model, _ = screen_model(frame, quad)
        inside = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(inside, quad.astype(np.int32), 255)
        inside = cv2.GaussianBlur(cv2.dilate(inside, np.ones((9, 9), np.uint8)), (3, 3), 0).astype(np.float32) / 255
        # How much of each pixel is screen, from green dominance: the screen model's own value is 1, skin and the
        # bezel (green below red or blue by 30 or more) are 0, and a motion-blurred fingertip falls in between.
        b, g, r = [c.astype(np.float32) for c in cv2.split(frame)]
        gd = g - np.maximum(r, b)
        if model is None:
            gd_model = np.full(gd.shape, 70, np.float32)
            model = frame.astype(np.float32)
        else:
            mb, mg, mr = model[..., 0], model[..., 1], model[..., 2]
            gd_model = np.maximum(mg - np.maximum(mr, mb), 20)
        alpha_screen = np.clip((gd + 30) / (gd_model + 30), 0, 1) * inside
        alphas.append(alpha_screen)
        # The tap: the first frame a finger covers a sixth of the zone around the tracked button (the button plus one
        # button height above and below; a generated finger rarely lands dead centre).
        if button and contact is None:
            Hm = cv2.getPerspectiveTransform(src_corners, quad)
            zy0, zy1 = y0 - (y1 - y0), y1 + (y1 - y0)
            bx = cv2.perspectiveTransform(np.float32([[[x0, zy0]], [[x1, zy0]], [[x1, zy1]], [[x0, zy1]]]), Hm).astype(np.int32)
            bmask = np.zeros((h, w), np.uint8)
            cv2.fillConvexPoly(bmask, bx, 1)
            if bmask.sum() and ((alpha_screen < 0.5) & (bmask > 0)).sum() / bmask.sum() > 0.16:
                contact = i
        rendered.append(model)
    if contact is None:
        contact = int(switch * len(frames)) if switch < 1 else len(frames)
    writer = subprocess.Popen(["ffmpeg", "-hide_banner", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                               "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "15", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
    for i, (frame, quad, a, model) in enumerate(zip(frames, quads, alphas, rendered)):
        state = "before" if i < contact else "pressed" if i < contact + 3 else "after"
        glass, _ = looks[state]
        Hm = cv2.getPerspectiveTransform(src_corners, quad)
        ui = cv2.warpPerspective(glass, Hm, (w, h), flags=cv2.INTER_AREA)
        velocity = (quad - quads[i - 1]).mean(0) if i else np.zeros(2)
        ui = cv2.GaussianBlur(motion_blur(ui, velocity), (0, 0), 0.6)
        # The plate's screen glow falloff carries over to the UI (within +-10%).
        luma = model.mean(2)
        ref_l = luma[a > 0.9]
        if ref_l.size:
            ui *= np.clip(luma / ref_l.mean(), 0.9, 1.1)[..., None]
        f = frame.astype(np.float32)
        # Additive replacement: swap only the screen's share of each pixel for the UI. Pure screen becomes the UI
        # plus the plate's own grain (its luminance residual); a finger, or the finger's share of a blurred edge,
        # is left exactly as filmed.
        res = f - model
        res_luma = res.mean(2, keepdims=True)
        a3 = a[..., None]
        result = f + a3 * (ui - model) - a3 * a3 * (res - res_luma)
        # A soft bloom of the screen onto the bezel and fingers.
        result += cv2.GaussianBlur(ui * a3, (0, 0), 6) * 0.06 * (1 - a3)
        writer.stdin.write(result.clip(0, 255).astype(np.uint8).tobytes())
    writer.stdin.close()
    writer.wait()
    print(f"{out}: tracked {tracked}/{len(frames)} frames from reference frame {ref}; tap at frame {contact} of {len(frames)} (track)")
    sys.exit(0)
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
