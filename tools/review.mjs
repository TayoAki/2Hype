#!/usr/bin/env node
// Review page for a remake: the reference and ours side by side, frame by frame, shot by shot, with the stills each
// shot is built from, the checks against the reference, and the cost of animating each shot on each Seedance model.
// The producer picks a model per shot (or skip), approves shots and adds notes, then copies the decisions as JSON
// (tools/keyframes.mjs frames --decisions reads them).
//
//   node tools/review.mjs --template <filled template.json> --reference-shots <reference shots.json>
//        [--reference <reference.mp4>] [--render <our render.mp4>] [--stills <dir>] [--check <check.json>]
//        [--title "..."] [--out review.html]
//
// Everything is embedded (videos at 640 px, frames as JPEG), so the page is one file. A page that embeds someone
// else's video is for private review only: keep it local, never publish it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
if (args.includes("-h") || args.includes("--help") || !opt("--template") || !opt("--reference-shots")) {
  console.error("Usage: node tools/review.mjs --template <template.json> --reference-shots <shots.json> [--reference <video>] [--render <video>]\n" +
    "                         [--stills <dir>] [--check <check.json>] [--title <text>] [--out review.html]");
  process.exit(args.includes("-h") || args.includes("--help") ? 0 : 1);
}
const template = JSON.parse(readFileSync(resolve(opt("--template")), "utf8"));
const refShots = JSON.parse(readFileSync(resolve(opt("--reference-shots")), "utf8"));
const refVideo = opt("--reference"), render = opt("--render"), stillsDir = opt("--stills"), checkPath = opt("--check");
const check = checkPath && existsSync(checkPath) ? JSON.parse(readFileSync(resolve(checkPath), "utf8")) : null;
const out = resolve(opt("--out", "review.html"));
const fps = template.timelineFps ?? Math.round(template.fps ?? 24);

// Seedance on OpenRouter, USD per second of output (video tokens = width x height x seconds x 24 / 1024).
const RATES = {
  "mini-720p": { label: "2.0 Mini 720p", perSecond: (1280 * 720 * 24 / 1024) * 3.5e-6 },
  "fast-720p": { label: "2.0 Fast 720p", perSecond: (1280 * 720 * 24 / 1024) * 4.2e-6 },
  "standard-720p": { label: "2.0 full 720p", perSecond: (1280 * 720 * 24 / 1024) * 7.0e-6 },
  "standard-1080p": { label: "2.0 full 1080p", perSecond: (1920 * 1080 * 24 / 1024) * 7.7e-6 },
  skip: { label: "skip (keep as is)", perSecond: 0 },
};
const STILL_COST = 0.053;  // GPT Image 2 at 1K with references, measured on this account
const margin = template.keyframes?.margin ?? 0.5;
const billed = (slot) => Math.min(15, Math.max(4, Math.ceil(slot.duration + margin)));

function run(command, list, encoding = "buffer") {
  const result = spawnSync(command, list, { encoding, maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).slice(-400)}`);
  return result.stdout;
}
const jpeg = (path, at, width) => run("ffmpeg", ["-v", "error", ...(at === undefined ? [] : ["-ss", at.toFixed(3)]), "-i", path, "-frames:v", "1",
  "-vf", `scale=${width}:-2`, "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "-"]).toString("base64");
/** The video twice, as WebM (VP9; Chromium builds without H.264 play it) and MP4 (H.264; Safari), 640 px wide. */
function videoData(path) {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  const webm = join(dir, "v.webm"), mp4 = join(dir, "v.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-i", path, "-vf", "scale=640:-2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1",
    "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-b:a", "48k", webm]);
  run("ffmpeg", ["-v", "error", "-y", "-i", path, "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", mp4]);
  const data = { webm: readFileSync(webm).toString("base64"), mp4: readFileSync(mp4).toString("base64") };
  rmSync(dir, { recursive: true, force: true });
  return data;
}

const refById = new Map(refShots.shots.map((s) => [s.shot, s]));
const still = (name) => {
  if (!stillsDir) return null;
  for (const ext of ["png", "jpg"]) { const p = join(resolve(stillsDir), `${name}.${ext}`); if (existsSync(p)) return p; }
  return null;
};
const slots = template.slots.map((s) => {
  const r = refById.get(s.slot) ?? {};
  const times = [0.15, 0.5, 0.85].map((f) => s.start + f * s.duration);
  const pad = String(s.slot).padStart(2, "0");
  const stills = [["first frame", still(`slot-${pad}-ui`) ?? still(`slot-${pad}`)], ["last frame", still(`slot-${pad}-last-ui`) ?? still(`slot-${pad}-last`)],
    ["set plate", s.setup || s.groupWith ? still(`plate-${s.groupWith ?? s.setup}`) : null]].filter(([, p]) => p);
  return {
    slot: s.slot, start: s.start, duration: s.duration, startFrame: s.startFrame, frames: s.frames, setup: s.setup ?? null, generate: s.generate !== false,
    prompt: s.prompt ?? "", billed: billed(s),
    want: Object.fromEntries(["people_count", "extras_count", "shot_size", "angle", "camera_move", "facing", "subject_position", "subject_scale", "setting", "device", "held_prop", "medium"]
      .filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
    ref: refVideo ? times.map((t) => jpeg(refVideo, t, 320)) : [],
    ours: render ? times.map((t) => jpeg(render, t, 320)) : [],
    stills: stills.map(([label, path]) => ({ label, data: jpeg(path, undefined, 480) })),
    check: check?.slots?.[s.slot] ?? null,
    refLabel: [r.shot_size, r.angle, r.camera_move].filter(Boolean).join(" · "),
  };
});
const data = {
  title: opt("--title", `Remake review: ${basename(opt("--template"))}`), fps, rates: RATES, stillCost: STILL_COST, slots,
  setups: check?.setups ?? null, lines: check?.lines ?? null, screens: check?.screens ?? null, checkCost: check?.cost ?? null,
  stillsCount: slots.reduce((n, s) => n + s.stills.filter((x) => x.label !== "set plate").length, 0) + new Set(slots.filter((s) => s.stills.some((x) => x.label === "set plate")).map((s) => s.setup)).size,
};
const refData = refVideo ? videoData(refVideo) : null, oursData = render ? videoData(render) : null;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Remake review</title>
<style>
:root { --bg:#0f1012; --panel:#17191c; --line:#2a2d32; --text:#e9e9ea; --muted:#9a9ca1; --ok:#4caf72; --warn:#e2a93b; --bad:#e0584a; --accent:#7aa7ff; }
* { box-sizing: border-box; }
[hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
header { position:sticky; top:0; z-index:5; background:rgba(15,16,18,.96); border-bottom:1px solid var(--line); padding:10px 16px; }
h1 { font-size:17px; margin:0 0 6px; }
.totals { display:flex; flex-wrap:wrap; gap:8px 18px; color:var(--muted); align-items:center; }
.totals b { color:var(--text); font-variant-numeric:tabular-nums; }
button, select, textarea { font:inherit; color:var(--text); background:#22252a; border:1px solid var(--line); border-radius:6px; padding:4px 8px; }
button { cursor:pointer; } button:hover { border-color:var(--accent); }
.layout { display:grid; grid-template-columns:minmax(360px, 44%) 1fr; gap:0; }
aside { position:sticky; top:var(--head, 96px); align-self:start; max-height:calc(100vh - var(--head, 96px)); overflow:auto; padding-bottom:12px; }
.players { display:grid; grid-template-columns:1fr; gap:10px; padding:12px 16px 0; }
.player { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; }
.player h2 { font-size:13px; margin:0 0 6px; color:var(--muted); font-weight:600; }
.player video, .player img { width:100%; aspect-ratio:16/9; object-fit:contain; background:#000; border-radius:4px; display:block; }
.transport { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 16px; }
.transport .pos { font-variant-numeric:tabular-nums; color:var(--muted); }
input[type=range] { flex:1; min-width:200px; }
main { padding:12px 16px 40px 0; display:grid; gap:12px; align-content:start; }
.card { background:var(--panel); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; padding:10px 12px; scroll-margin-top:120px; }
.card.current { border-color:var(--accent); }
.card.pass { border-left-color:var(--ok); } .card.fail { border-left-color:var(--bad); } .card.waived { border-left-color:var(--warn); }
.card h3 { margin:0; font-size:15px; display:flex; gap:10px; align-items:baseline; flex-wrap:wrap; }
.card h3 small { color:var(--muted); font-weight:400; }
.rows { display:grid; grid-template-columns:110px 1fr; gap:6px 10px; margin-top:8px; align-items:start; }
.rows > .k { color:var(--muted); font-size:12px; padding-top:4px; }
.strip { display:flex; gap:6px; overflow-x:auto; }
.strip img { height:110px; border-radius:4px; cursor:pointer; }
.strip figure { margin:0; } .strip figcaption { font-size:11px; color:var(--muted); }
.chips { display:flex; flex-wrap:wrap; gap:4px; }
.chip { font-size:12px; border-radius:10px; padding:1px 8px; background:#24272c; border:1px solid var(--line); }
.chip.bad { border-color:var(--bad); color:#ffb3aa; } .chip.ok { border-color:#2f5f40; color:#9fd8b0; } .chip.waive { border-color:var(--warn); color:#f3d08f; }
.decide { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.decide textarea { width:100%; min-height:34px; }
.cost { font-variant-numeric:tabular-nums; }
.muted { color:var(--muted); }
details { margin-top:6px; } summary { cursor:pointer; color:var(--muted); }
#out { width:100%; min-height:120px; margin-top:8px; font-family:ui-monospace, Menlo, monospace; font-size:12px; }
@media (max-width:820px) { .layout { grid-template-columns:1fr; } aside { position:static; max-height:none; } main { padding:8px 16px 40px; } .rows { grid-template-columns:1fr; } .strip img { height:84px; } }
</style></head><body>
<header>
  <h1 id="title"></h1>
  <div class="totals">
    <span>Animate: <b id="secs"></b> s over <b id="nshots"></b> shots</span>
    <span>Video: <b id="vcost"></b></span>
    <span>Stills so far: <b id="scost"></b></span>
    <span>Approved: <b id="napproved"></b></span>
    <span>Checks: <b id="nchecks"></b></span>
    <label>Set all to <select id="all"></select></label>
    <button id="copy">Copy decisions</button>
  </div>
</header>
<div class="layout"><aside>
<section class="players">
  <div class="player"><h2>Reference</h2><video id="ref" muted playsinline preload="auto"></video></div>
  <div class="player"><h2 id="oursTitle">Ours</h2><video id="ours" muted playsinline preload="auto"></video><img id="oursStill" alt="" hidden></div>
</section>
<div class="transport">
  <button id="play">Play</button><button id="back">◀ frame</button><button id="fwd">frame ▶</button>
  <button id="prevShot">⏮ shot</button><button id="nextShot">shot ⏭</button>
  <input id="scrub" type="range" min="0" step="1" value="0">
  <span class="pos" id="pos"></span>
  <label class="muted"><input type="checkbox" id="sound"> sound</label>
</div>
<p class="muted" style="padding:0 16px">Keys: ← → one frame · ↑ ↓ one shot · space play. Click a frame or a shot title to jump there.</p>
</aside>
<main id="cards"></main></div>
<section style="padding:0 16px 40px"><h2 style="font-size:15px">Decisions</h2>
<p class="muted">Copy this and paste it back in the chat (or save it as decisions.json for <code>tools/keyframes.mjs frames --decisions</code>).</p>
<textarea id="out" readonly></textarea></section>
<script>
const DATA = ${JSON.stringify(data)};
const REF = ${refData ? JSON.stringify(refData) : "null"};
const OURS = ${oursData ? JSON.stringify(oursData) : "null"};
const sources = (v, d) => { for (const [type, b64] of [["video/webm", d.webm], ["video/mp4", d.mp4]]) v.append(Object.assign(document.createElement("source"), { type, src: "data:" + type + ";base64," + b64 })); v.load(); };
const $ = (id) => document.getElementById(id);
const setHead = () => document.documentElement.style.setProperty("--head", document.querySelector("header").offsetHeight + "px");
window.addEventListener("resize", setHead);
if (window.ResizeObserver) new ResizeObserver(setHead).observe(document.querySelector("header"));
const key = "remake-review:" + DATA.title;
let saved = {}; try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { saved = {}; }
const save = () => { try { localStorage.setItem(key, JSON.stringify(saved)); } catch (e) {} };
const money = (v) => "$" + v.toFixed(2);
$("title").textContent = DATA.title;
const frames = DATA.slots.reduce((n, s) => Math.max(n, s.startFrame + s.frames), 0);
$("scrub").max = frames - 1;
const ref = $("ref"), ours = $("ours");
if (REF) sources(ref, REF); else ref.replaceWith(Object.assign(document.createElement("p"), { className: "muted", textContent: "No reference video embedded." }));
if (OURS) { sources(ours, OURS); $("oursTitle").textContent = "Ours (current render)"; } else { ours.hidden = true; $("oursStill").hidden = false; $("oursTitle").textContent = "Ours (first-frame still of the current shot)"; }
const slotAt = (f) => DATA.slots.find((s) => f >= s.startFrame && f < s.startFrame + s.frames) || DATA.slots[DATA.slots.length - 1];
let frame = 0, playing = false, timer = null;
function show(f, fromVideo) {
  frame = Math.max(0, Math.min(frames - 1, f));
  const t = (frame + 0.5) / DATA.fps;
  if (!fromVideo) { if (REF) ref.currentTime = t; if (OURS) ours.currentTime = t; }
  $("scrub").value = frame;
  const s = slotAt(frame);
  $("pos").textContent = "frame " + frame + " / " + (frames - 1) + " · " + (frame / DATA.fps).toFixed(2) + "s · shot " + s.slot + " (frame " + (frame - s.startFrame + 1) + " of " + s.frames + ")";
  document.querySelectorAll(".card").forEach((c) => c.classList.toggle("current", c.dataset.slot == s.slot));
  if (!OURS) { const st = s.stills.find((x) => x.label === "first frame"); $("oursStill").src = st ? "data:image/jpeg;base64," + st.data : ""; }
}
function play() {
  playing = !playing; $("play").textContent = playing ? "Pause" : "Play";
  if (playing) {
    if (REF) { ref.muted = !$("sound").checked; ref.play(); }
    if (OURS) { ours.muted = REF ? true : !$("sound").checked; ours.play(); }
    timer = setInterval(() => { const v = REF ? ref : OURS ? ours : null; show(v ? Math.floor(v.currentTime * DATA.fps) : frame + 1, !!v); if (!v && frame >= frames - 1) play(); }, 1000 / DATA.fps);
  } else { clearInterval(timer); if (REF) ref.pause(); if (OURS) ours.pause(); show(frame); }
}
$("play").onclick = play;
$("back").onclick = () => { if (playing) play(); show(frame - 1); };
$("fwd").onclick = () => { if (playing) play(); show(frame + 1); };
const jumpShot = (d) => { const i = DATA.slots.indexOf(slotAt(frame)); const s = DATA.slots[Math.max(0, Math.min(DATA.slots.length - 1, i + d))]; if (playing) play(); show(s.startFrame); };
$("prevShot").onclick = () => jumpShot(-1); $("nextShot").onclick = () => jumpShot(1);
$("scrub").oninput = (e) => { if (playing) play(); show(+e.target.value); };
document.addEventListener("keydown", (e) => {
  if (["TEXTAREA", "SELECT", "INPUT"].includes(document.activeElement.tagName) && document.activeElement.type !== "range") return;
  if (e.key === "ArrowRight") { e.preventDefault(); $("fwd").click(); } else if (e.key === "ArrowLeft") { e.preventDefault(); $("back").click(); }
  else if (e.key === " ") { e.preventDefault(); play(); } else if (e.key === "ArrowDown") { e.preventDefault(); jumpShot(1); } else if (e.key === "ArrowUp") { e.preventDefault(); jumpShot(-1); }
});
const options = Object.entries(DATA.rates).map(([k, r]) => '<option value="' + k + '">' + r.label + (r.perSecond ? " · $" + r.perSecond.toFixed(3) + "/s" : "") + "</option>").join("");
$("all").innerHTML = '<option value="">…</option>' + options;
$("all").onchange = (e) => { if (!e.target.value) return; DATA.slots.forEach((s) => { if (s.generate) (saved[s.slot] ||= {}).model = e.target.value; }); save(); render(); };
const label = (k) => k.replace(/_/g, " ");
function chips(s) {
  if (!s.check) return '<span class="muted">not checked yet</span>';
  const c = s.check, out = [];
  for (const m of c.misses || []) out.push('<span class="chip ' + (m.waived ? "waive" : "bad") + '" title="' + (m.waived ? "waived: " + m.waived : "") + '">' + label(m.field) + ": " + m.got + " (want " + m.want + ")" + "</span>");
  for (const p of c.cast || []) out.push('<span class="chip ' + (p.ok ? "ok" : "bad") + '">' + p.name + ": " + (p.ok ? "matches sheet" : !p.present ? "missing" : p.matches_design === false ? "looks wrong" + (p.note ? " (" + p.note + ")" : "") : "only in the background") + "</span>");
  if (c.castOthers) out.push('<span class="chip bad">' + c.castOthers + " unexpected character" + (c.castOthers > 1 ? "s" : "") + "</span>");
  if (c.setup) out.push('<span class="chip ' + (c.setup.same ? "ok" : "bad") + '">set ' + (c.setup.same ? "matches" : "differs from") + " plate " + (c.setup.plate || "") + (c.setup.note ? ": " + c.setup.note : "") + "</span>");
  if (!out.length) out.push('<span class="chip ok">every checked variable matches</span>');
  return out.join("");
}
function render() {
  $("cards").innerHTML = DATA.slots.map((s) => {
    const d = saved[s.slot] || {}, model = d.model || (s.generate ? "mini-720p" : "skip");
    const cost = DATA.rates[model].perSecond * s.billed;
    const status = !s.check ? "" : s.check.pass ? (s.check.misses || []).some((m) => m.waived) ? "waived" : "pass" : "fail";
    const img = (b64, cap, at) => '<figure><img src="data:image/jpeg;base64,' + b64 + '" data-at="' + (at ?? "") + '"><figcaption>' + cap + "</figcaption></figure>";
    const caps = ["start", "middle", "end"], at = [0.15, 0.5, 0.85].map((f) => Math.floor(s.startFrame + f * s.frames));
    return '<article class="card ' + status + '" data-slot="' + s.slot + '" id="shot-' + s.slot + '">' +
      "<h3>Shot " + s.slot + " <small>" + s.start.toFixed(2) + "s · " + s.duration.toFixed(2) + "s · " + s.frames + " frames" + (s.setup ? " · setup " + s.setup : "") + (s.refLabel ? " · " + s.refLabel : "") + "</small></h3>" +
      '<div class="rows">' +
      (s.ref.length ? '<div class="k">Reference</div><div class="strip">' + s.ref.map((b, i) => img(b, caps[i], at[i])).join("") + "</div>" : "") +
      (s.ours.length ? '<div class="k">Ours (render)</div><div class="strip">' + s.ours.map((b, i) => img(b, caps[i], at[i])).join("") + "</div>" : "") +
      (s.stills.length ? '<div class="k">Our stills</div><div class="strip">' + s.stills.map((x) => img(x.data, x.label)).join("") + "</div>" : "") +
      '<div class="k">Must match</div><div class="chips">' + Object.entries(s.want).map(([k, v]) => '<span class="chip">' + label(k) + ": " + v + "</span>").join("") + "</div>" +
      '<div class="k">Check</div><div class="chips">' + chips(s) + "</div>" +
      '<div class="k">Our shot</div><div>' + s.prompt.replace(/</g, "&lt;") + "</div>" +
      '<div class="k">Animate</div><div class="decide">' +
        '<select data-k="model">' + options + "</select>" +
        '<span class="cost">' + s.billed + " s billed · " + money(cost) + "</span>" +
        '<label><input type="checkbox" data-k="approve"' + (d.approve ? " checked" : "") + "> approve</label>" +
        '<textarea data-k="note" placeholder="Notes for this shot (what to change)">' + (d.note || "") + "</textarea>" +
      "</div></div></article>";
  }).join("");
  document.querySelectorAll(".card").forEach((card) => {
    const n = +card.dataset.slot, s = DATA.slots.find((x) => x.slot === n), d = saved[n] || {};
    card.querySelector('[data-k="model"]').value = d.model || (s.generate ? "mini-720p" : "skip");
    card.querySelectorAll("[data-k]").forEach((el) => el.addEventListener(el.tagName === "TEXTAREA" ? "input" : "change", () => {
      const v = el.type === "checkbox" ? el.checked : el.value; (saved[n] ||= {})[el.dataset.k] = v; save(); if (el.tagName !== "TEXTAREA") render(); else totals();
    }));
    card.querySelectorAll("img[data-at]").forEach((im) => im.addEventListener("click", () => { if (im.dataset.at !== "") { if (playing) play(); show(+im.dataset.at); if (innerWidth <= 820) window.scrollTo({ top: 0, behavior: "smooth" }); } }));
    card.querySelector("h3").addEventListener("click", () => { if (playing) play(); show(s.startFrame); if (innerWidth <= 820) window.scrollTo({ top: 0, behavior: "smooth" }); });
  });
  totals(); show(frame);
}
function totals() {
  let secs = 0, cost = 0, n = 0, approved = 0, pass = 0, checked = 0;
  for (const s of DATA.slots) {
    const d = saved[s.slot] || {}, model = d.model || (s.generate ? "mini-720p" : "skip");
    if (model !== "skip") { secs += s.billed; cost += DATA.rates[model].perSecond * s.billed; n++; }
    if (d.approve) approved++;
    if (s.check) { checked++; if (s.check.pass) pass++; }
  }
  $("secs").textContent = secs; $("nshots").textContent = n; $("vcost").textContent = money(cost) + " (+5.5% when buying credit)";
  $("scost").textContent = DATA.stillsCount + " stills ≈ " + money(DATA.stillsCount * DATA.stillCost) + (DATA.checkCost ? " + checks " + money(DATA.checkCost) : "");
  $("napproved").textContent = approved + " of " + DATA.slots.length; $("nchecks").textContent = checked ? pass + " of " + checked + " shots pass" : "not run";
  const decisions = Object.fromEntries(DATA.slots.map((s) => { const d = saved[s.slot] || {}; return [s.slot, { model: d.model || (s.generate ? "mini-720p" : "skip"), approve: !!d.approve, ...(d.note ? { note: d.note } : {}) }]; }));
  $("out").value = JSON.stringify({ format: "remake-review.decisions@1", decisions }, null, 1);
}
$("copy").onclick = async () => { totals(); try { await navigator.clipboard.writeText($("out").value); $("copy").textContent = "Copied"; } catch (e) { $("out").select(); $("copy").textContent = "Select and copy below"; } setTimeout(() => ($("copy").textContent = "Copy decisions"), 1500); };
setHead();
render();
</script></body></html>
`;
writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1e6).toFixed(1)} MB): ${slots.length} shots${refVideo ? ", reference video" : ""}${render ? ", our render" : ""}${stillsDir ? `, ${data.stillsCount} stills` : ""}${check ? ", checks" : ""}.`);
