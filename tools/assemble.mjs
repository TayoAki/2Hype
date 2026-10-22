#!/usr/bin/env node
// Cut every slot of a template out of the generated multi-shot clips and grade it to the template's look.
// Reads clips-plan.json (written by `shot-list.mjs --svml ... --group-by setup`) and the filled template.json.
// Needs ffmpeg and ffprobe on PATH. No npm dependencies, no network.
//
//   node tools/assemble.mjs --plan clips-plan.json --template template.json --takes assets/takes --out assets/slots
//                           [--threshold 0.12] [--max-slowdown 1.35] [--no-grade]
//
// For each clip (<takes>/<clip id>.mp4) it finds the hard cuts, keeping the strongest ones when there are more
// candidates than planned shots, and maps shots to slots in plan order. Each slot's segment is cut from inside its
// own shot (two frames clear of either cut), centred in the shot unless the slot sets "cutAlign" (or the plan's shot
// sets "align"): "start" or "end",
// and slowed down (at most --max-slowdown, with motion-interpolated frames) when the shot came out shorter than the slot. When the template gives a
// slot "brightness" and "saturation", the segment is graded just far enough to sit inside the template's tolerance
// (brightness within 8%, saturation within 20%), so our palette changes as little as possible.
//
// Writes <out>/slot-NN.mp4 (exactly the slot's frames at the timeline rate, plus one), <out>/assembly.json and
// <out>/assembly-sheet.jpg (the first, middle and last frame of every segment, for review).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const planPath = option("--plan"), templatePath = option("--template"), takes = option("--takes"), out = option("--out");
if (!planPath || !templatePath || !takes || !out) {
  console.error("Usage: node tools/assemble.mjs --plan clips-plan.json --template template.json --takes <dir> --out <dir> [--threshold 0.12] [--max-slowdown 1.35] [--no-grade]");
  process.exit(1);
}
const threshold = Number(option("--threshold", 0.12)), maxSlowdown = Number(option("--max-slowdown", 1.35)), grade = !args.includes("--no-grade");
const round = (n) => Math.round(n * 1000) / 1000;

function run(command, list, encoding = "utf8") {
  const result = spawnSync(command, list, { encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim().split("\n").slice(-3).join(" ")}`);
  return result;
}

function probe(file) {
  const info = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate:format=duration", "-of", "json", file]).stdout);
  const [num, den] = info.streams[0].r_frame_rate.split("/").map(Number);
  return { duration: Number(info.format.duration), fps: den ? num / den : num };
}

/** Scene-change score of every frame. */
function sceneScores(file) {
  const { stdout } = run("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-an", "-vf", "select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", "-f", "null", "-"]);
  const scores = [];
  let t = null;
  for (const line of stdout.split("\n")) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) t = Number(time[1]);
    const score = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (score && t !== null) scores.push({ t, score: Number(score[1]) });
  }
  return scores;
}

/**
 * One cut per planned shot boundary. Strong cuts (above the threshold) are matched to the nearest planned boundary
 * (scaled to the clip's length) within a second. A boundary left without one is usually a cut between two shots of
 * the same setup, which scores low: take the highest scene-score peak within 0.7 s of where the matched cuts say it
 * should be, and only when there is no peak at all use that expected position.
 */
function findCuts(scores, planned, duration) {
  const scale = duration / planned.at(-1).to;
  const expected = planned.slice(1).map((s) => s.from * scale);
  // Strong cuts, one per 0.3 s neighbourhood (the highest score wins).
  const strong = [];
  for (const c of scores.filter((s) => s.score >= threshold && s.t > 0.25 && s.t < duration - 0.25).sort((a, b) => b.score - a.score)) {
    if (strong.every((x) => Math.abs(x.t - c.t) >= 0.3)) strong.push(c);
  }
  // Exactly as many strong cuts as planned: the shots are all there, however far their lengths drifted.
  if (strong.length === expected.length) return strong.sort((a, b) => a.t - b.t).map((c) => ({ ...c, kind: "strong" }));
  const pairs = [];
  for (const c of strong) expected.forEach((e, k) => { if (Math.abs(c.t - e) <= 1.0) pairs.push({ k, c, d: Math.abs(c.t - e) }); });
  pairs.sort((a, b) => a.d - b.d);
  const cuts = expected.map(() => null);
  const used = new Set();
  for (const p of pairs) if (!cuts[p.k] && !used.has(p.c) && cuts.every((x) => !x || Math.abs(x.t - p.c.t) >= 0.3)) { cuts[p.k] = { ...p.c, kind: "strong" }; used.add(p.c); }
  // Keep the matched cuts in order; drop any that would cross a neighbour.
  for (let k = 1; k < cuts.length; k++) if (cuts[k] && cuts[k - 1] && cuts[k].t <= cuts[k - 1].t) cuts[k] = null;
  const anchor = (k) => {  // expected position re-scaled between the nearest matched cuts on either side
    let left = k - 1, right = k + 1;
    while (left >= 0 && !cuts[left]) left--;
    while (right < cuts.length && !cuts[right]) right++;
    const [pl, al] = left >= 0 ? [expected[left], cuts[left].t] : [0, 0];
    const [pr, ar] = right < cuts.length ? [expected[right], cuts[right].t] : [duration, duration];
    return al + ((expected[k] - pl) * (ar - al)) / (pr - pl);
  };
  for (let k = 0; k < cuts.length; k++) {
    if (cuts[k]) continue;
    const e = anchor(k);
    const near = scores.filter((s) => Math.abs(s.t - e) <= 0.7 && cuts.every((x) => !x || Math.abs(x.t - s.t) >= 0.3));
    const peak = near.sort((a, b) => b.score - a.score)[0];
    cuts[k] = peak && peak.score >= 0.03 ? { ...peak, kind: "soft" } : { t: e, score: 0, kind: "estimated" };
  }
  return cuts;
}

/** Mean brightness (Y) and saturation over a few frames of a span. */
function look(file, start, seconds) {
  const { stdout } = run("ffmpeg", ["-hide_banner", "-v", "error", "-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an",
    "-vf", "fps=6,scale=320:-2,signalstats,metadata=print:file=-", "-f", "null", "-"]);
  const y = [...stdout.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  const sat = [...stdout.matchAll(/signalstats\.SATAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  return { y: mean(y), sat: mean(sat) };
}

const plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));
const template = JSON.parse(readFileSync(resolve(templatePath), "utf8"));
const slots = new Map(template.slots.map((s) => [s.slot, s]));
const fps = plan.timelineFps;
mkdirSync(resolve(out), { recursive: true });
const report = { format: "assemble@1", timelineFps: fps, clips: [], slots: [] };

for (const clip of plan.clips) {
  const file = join(resolve(takes), `${clip.id}.mp4`);
  const info = probe(file);
  const frame = 1 / info.fps;
  const cuts = findCuts(sceneScores(file), clip.shots, info.duration);
  const warnings = cuts.flatMap((c, k) => (c.kind === "estimated" ? [`no cut found between shots ${k + 1} and ${k + 2}; used the expected time ${round(c.t)}s`] : []));
  const bounds = [0, ...cuts.map((c) => c.t), info.duration];
  report.clips.push({ id: clip.id, duration: round(info.duration), planned: clip.shots.map((s) => [s.from, s.to]),
    detected: bounds.slice(0, -1).map((b, i) => [round(b), round(bounds[i + 1])]), cuts: cuts.map((c) => ({ t: round(c.t), score: round(c.score), kind: c.kind })), warnings });
  clip.shots.forEach((shot, k) => {
    if (shot.skip) return;  // a later clip in the plan replaces this slot
    const slot = slots.get(shot.slot);
    const frames = slot.frames ?? shot.frames;
    const need = (frames + 1) / fps;
    const safeStart = bounds[k] + 2 * frame, safeEnd = bounds[k + 1] - 2 * frame;
    const safe = Math.max(0, safeEnd - safeStart);
    let start, seconds, slowdown = 1;
    if (safe >= need) {
      const align = shot.align ?? slot.cutAlign ?? "center";  // a clip animated from a keyframe starts on it: "start"
      start = align === "start" ? safeStart : align === "end" ? safeEnd - need : safeStart + (safe - need) / 2;
      seconds = need;
    } else {
      slowdown = Math.min(maxSlowdown, need / Math.max(safe, frame));
      start = safeStart;
      seconds = safe;
      if (need / Math.max(safe, frame) > maxSlowdown) warnings.push(`slot ${shot.slot}: shot is ${round(safe)}s for a ${round(need)}s slot; held the last frame after a ${maxSlowdown}x slowdown`);
    }
    // Grade into a band inside the template's tolerance: brightness within 8%, saturation within 20% of the slot's
    // values. Brightness moves with a gamma curve (mid-tones move, black and white stay put), saturation with a gain.
    const measured = look(file, start, seconds);
    let gamma = 1, saturation = 1;
    if (grade && slot.brightness !== undefined) {
      const y = Math.min(Math.max(measured.y, slot.brightness * 0.92), slot.brightness * 1.08);
      gamma = Math.max(0.6, Math.min(1.8, Math.log(measured.y / 255) / Math.log(y / 255)));
      if (slot.saturation >= 8) {
        const s = Math.min(Math.max(measured.sat, slot.saturation * 0.8), slot.saturation * 1.2);
        saturation = Math.max(0.6, Math.min(1.6, s / measured.sat));
      }
    }
    const target = join(resolve(out), `slot-${String(shot.slot).padStart(2, "0")}.mp4`);
    // A slowed shot gets motion-interpolated in-between frames instead of repeated ones (repeats read as judder).
    const retime = slowdown > 1.001 ? `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `fps=${fps}`;
    const filters = [`setpts=(PTS-STARTPTS)*${round(slowdown)}`, retime, "tpad=stop_mode=clone:stop_duration=2",
      ...(Math.abs(gamma - 1) > 0.005 || saturation !== 1 ? [`eq=gamma=${round(gamma)}:saturation=${round(saturation)}`] : [])];
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-an",
      "-vf", filters.join(","), "-frames:v", String(frames + 1), "-c:v", "libx264", "-crf", "15", "-preset", "medium", "-pix_fmt", "yuv420p", target]);
    report.slots.push({ slot: shot.slot, clip: clip.id, file: target, frames, shot: [round(bounds[k]), round(bounds[k + 1])],
      window: [round(start), round(start + seconds)], slowdown: round(slowdown),
      look: { measured: { y: round(measured.y), sat: round(measured.sat) }, target: { y: slot.brightness, sat: slot.saturation }, gamma: round(gamma), saturation: round(saturation) } });
  });
  for (const w of warnings) console.warn(`  ${clip.id}: ${w}`);
  console.log(`${clip.id}: ${clip.shots.length} shots; cuts ${cuts.map((c) => `${c.t.toFixed(2)}s ${c.kind}`).join(", ")}`);
}

// A slot cut twice (a replacement clip later in the plan) keeps its last cut.
report.slots = [...new Map(report.slots.map((s) => [s.slot, s])).values()].sort((a, b) => a.slot - b.slot);
writeFileSync(join(resolve(out), "assembly.json"), `${JSON.stringify(report, null, 2)}\n`);
// Review sheet: first, middle and last frame of every segment, one row per slot.
const tiles = [];
for (const s of report.slots) {
  for (const [k, at] of [[0, 0.02], [1, 0.5], [2, 0.98]]) {
    const tile = join(resolve(out), `.sheet-${String(s.slot).padStart(2, "0")}-${k}.png`);
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", ((s.frames / fps) * at).toFixed(3), "-i", s.file, "-frames:v", "1",
      "-vf", `scale=320:180,drawtext=text='${s.slot}':x=6:y=4:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6`, tile]);
    tiles.push(tile);
  }
}
const columns = 6, rows = Math.ceil(tiles.length / columns);
run("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...tiles.flatMap((t) => ["-i", t]), "-filter_complex",
  `${tiles.map((_, i) => `[${i}]`).join("")}xstack=inputs=${tiles.length}:layout=${tiles.map((_, i) => `${(i % columns) * 320}_${Math.floor(i / columns) * 180}`).join("|")}:fill=black`,
  "-frames:v", "1", join(resolve(out), "assembly-sheet.jpg")]);
const slowed = report.slots.filter((s) => s.slowdown > 1).map((s) => `${s.slot} (${s.slowdown}x)`);
const graded = report.slots.filter((s) => s.look.gamma !== 1 || s.look.saturation !== 1).map((s) => s.slot);
console.log(`Wrote ${report.slots.length} segments to ${resolve(out)} at ${fps} fps; slowed ${slowed.join(", ") || "none"}; graded ${graded.join(", ") || "none"}.`);
console.log(`Review ${join(resolve(out), "assembly-sheet.jpg")} (first, middle, last frame of each slot).`);
