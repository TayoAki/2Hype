"""Lay a designed app screen into the green phone screens of a generated shot, frame by frame.
Needs Python 3 with numpy and opencv-python, and ffmpeg on PATH. Run it on ungraded cuts (assemble.mjs --no-grade):
grading first desaturates the green and the key fails. Generate the phones with solid bright green screens
(shot-list.mjs --svml asks for that on screen close-ups).
Green screens are found as bright, saturated, roughly rectangular green regions (so plants and green clothes are
left alone), keyed (a tapping finger stays in front) and filled with the screen image warped to their four corners.

  python3 tools/key-screen.py <in.mp4> <before.png> <after.png> <out.mp4> [--mode track|closeup|all]
                       [--button x0,y0,x1,y1] [--switch 0.55] [--glow x0,y0,x1,y1]

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
