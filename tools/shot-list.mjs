#!/usr/bin/env node
// Shot list for any video: cut points, one frame per shot, a contact sheet and a storyboard page.
// Needs ffmpeg and ffprobe on PATH; no npm dependencies.
//
//   node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]
//                            [--frame middle|first|last] [--width 540] [--columns 6]
//
// Writes into <dir> (default: <video name>-shots/):
//   shots.json, shots.csv   start, end, duration, timecodes and frame file for every shot
//   frames/shot-NNN.jpg     one frame per shot
//   contact-sheet.jpg       every frame in a grid
//   index.html              storyboard with timecodes, opens in any browser
//
// Detection uses ffmpeg's scene-change score (0-1). Lower --threshold finds softer cuts and also more
// false cuts; raise it for footage with fast motion or flashes. Dissolves and fades are not hard cuts and
// may be missed; cuts closer together than --min-shot seconds are merged.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

function usage(message) {
  if (message) console.error(`shot-list: ${message}\n`);
  console.error("Usage: node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]\n" +
    "                     [--frame middle|first|last] [--width 540] [--columns 6]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { threshold: 0.3, minShot: 0.25, frame: "middle", width: 540, columns: 6 };
  const names = { "--out": "out", "--threshold": "threshold", "--min-shot": "minShot", "--frame": "frame", "--width": "width", "--columns": "columns" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (names[arg]) {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      options[names[arg]] = ["out", "frame"].includes(names[arg]) ? value : Number(value);
    } else if (arg.startsWith("--")) {
      usage(`unknown option ${arg}`);
    } else if (options.video === undefined) {
      options.video = arg;
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  if (!options.video) usage("a video file is required");
  if (!(options.threshold > 0 && options.threshold < 1)) usage("--threshold must be between 0 and 1");
  if (!(options.minShot >= 0)) usage("--min-shot must be zero or more seconds");
  if (!["middle", "first", "last"].includes(options.frame)) usage("--frame must be middle, first or last");
  if (!(Number.isInteger(options.width) && options.width >= 64)) usage("--width must be a whole number of pixels, at least 64");
  if (!(Number.isInteger(options.columns) && options.columns >= 1)) usage("--columns must be a whole number");
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start (${result.error.message}); install ffmpeg and put it on PATH`);
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return result;
}

function probe(video) {
  const { stdout } = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,r_frame_rate:format=duration", "-of", "json", video]);
  const info = JSON.parse(stdout);
  const stream = info.streams?.[0];
  if (!stream) throw new Error(`${video} has no video stream`);
  const [num, den] = stream.r_frame_rate.split("/").map(Number);
  return { duration: Number(info.format.duration), fps: den ? num / den : num, width: stream.width, height: stream.height };
}

/** Times (seconds) where ffmpeg's scene score crosses the threshold. */
function detectCuts(video, threshold) {
  const { stderr } = run("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-an", "-sn",
    "-vf", `select='gt(scene\\,${threshold})',showinfo`, "-f", "null", "-"]);
  return [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Number(match[1]));
}

function buildShots(cuts, duration, minShot) {
  const bounds = [0];
  for (const cut of cuts.sort((a, b) => a - b)) {
    if (cut - bounds.at(-1) >= minShot && duration - cut >= minShot) bounds.push(cut);
  }
  bounds.push(duration);
  return bounds.slice(0, -1).map((start, i) => ({ index: i + 1, start, end: bounds[i + 1] }));
}

function timecode(seconds, fps) {
  const whole = Math.floor(seconds);
  const frames = Math.floor((seconds - whole) * fps + 1e-6);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}:${pad(frames)}`;
}

function frameTime(shot, where, fps) {
  const oneFrame = 1 / fps;
  if (where === "first") return Math.min(shot.start + oneFrame, shot.end - oneFrame);
  if (where === "last") return Math.max(shot.end - 2 * oneFrame, shot.start);
  return (shot.start + shot.end) / 2;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const video = resolve(options.video);
  const out = resolve(options.out ?? `${basename(video, extname(video))}-shots`);
  const framesDir = join(out, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const info = probe(video);
  const shots = buildShots(detectCuts(video, options.threshold), info.duration, options.minShot);
  for (const shot of shots) {
    shot.duration = shot.end - shot.start;
    shot.frameAt = frameTime(shot, options.frame, info.fps);
    shot.frame = `frames/shot-${String(shot.index).padStart(3, "0")}.jpg`;
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-ss", shot.frameAt.toFixed(3), "-i", video,
      "-frames:v", "1", "-vf", `scale=${options.width}:-2`, "-q:v", "2", join(out, shot.frame)]);
  }

  const rows = Math.ceil(shots.length / options.columns);
  const tileWidth = Math.min(options.width, 270);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-framerate", "1", "-i", join(framesDir, "shot-%03d.jpg"),
    "-vf", `scale=${tileWidth}:-2,tile=${options.columns}x${rows}:padding=4:color=black`, "-frames:v", "1",
    join(out, "contact-sheet.jpg")]);

  const round = (n) => Math.round(n * 1000) / 1000;
  const record = shots.map((s) => ({
    shot: s.index, start: round(s.start), end: round(s.end), duration: round(s.duration),
    startTimecode: timecode(s.start, info.fps), endTimecode: timecode(s.end, info.fps), frameAt: round(s.frameAt), frame: s.frame,
  }));
  const durations = shots.map((s) => s.duration);
  const summary = {
    video: basename(video), duration: round(info.duration), fps: round(info.fps), resolution: `${info.width}x${info.height}`,
    threshold: options.threshold, shots: shots.length, averageShot: round(info.duration / shots.length),
    shortestShot: round(Math.min(...durations)), longestShot: round(Math.max(...durations)),
  };
  writeFileSync(join(out, "shots.json"), `${JSON.stringify({ summary, shots: record }, null, 2)}\n`);
  writeFileSync(join(out, "shots.csv"), ["shot,start,end,duration,start_timecode,end_timecode,frame",
    ...record.map((r) => [r.shot, r.start, r.end, r.duration, r.startTimecode, r.endTimecode, r.frame].join(","))].join("\n") + "\n");
  writeFileSync(join(out, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shot list: ${escapeHtml(summary.video)}</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, sans-serif; background: #111; color: #eee; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 16px; color: #aaa; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  figure { margin: 0; } img { width: 100%; display: block; border-radius: 6px; }
  figcaption { margin-top: 4px; font-variant-numeric: tabular-nums; } b { color: #fff; } span { color: #999; }
</style></head><body>
<h1>${escapeHtml(summary.video)}</h1>
<p>${summary.shots} shots in ${summary.duration}s · average ${summary.averageShot}s · ${summary.resolution} at ${summary.fps} fps · scene threshold ${summary.threshold}</p>
<div class="grid">
${record.map((r) => `  <figure><img src="${r.frame}" alt="Shot ${r.shot}" loading="lazy"><figcaption><b>#${r.shot}</b> ${r.startTimecode}<br><span>${r.duration.toFixed(2)}s</span></figcaption></figure>`).join("\n")}
</div></body></html>
`);

  console.log(`${summary.shots} shots in ${summary.duration}s (average ${summary.averageShot}s, shortest ${summary.shortestShot}s, longest ${summary.longestShot}s)`);
  for (const r of record) console.log(`  #${String(r.shot).padStart(3)}  ${r.startTimecode} → ${r.endTimecode}  ${r.duration.toFixed(2)}s  ${r.frame}`);
  console.log(`Wrote ${out}/ (shots.json, shots.csv, frames/, contact-sheet.jpg, index.html)`);
}

try {
  main();
} catch (error) {
  console.error(`shot-list: ${error.message}`);
  process.exit(1);
}
