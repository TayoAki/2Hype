#!/usr/bin/env node
// Shot list for any video: cut points, one frame per shot, a contact sheet and a storyboard page.
// Optional: label each shot's visual grammar (--analyze), export a structure-only pacing template
// (--template), and turn a filled template into a Hypit project that generates new shots (--svml).
// Needs ffmpeg and ffprobe on PATH; --analyze also needs OPENROUTER_API_KEY. No npm dependencies.
//
//   node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]
//                            [--frame middle|first|last] [--width 540] [--columns 6]
//                            [--analyze [--model google/gemini-2.5-flash] [--concurrency 2]] [--template]
//   node tools/shot-list.mjs --svml <filled-template.json> [--out <dir>]
//
// Writes into <dir> (default: <video name>-shots/):
//   shots.json, shots.csv   start, end, duration, timecodes and frame file for every shot (plus labels)
//   frames/shot-NNN.jpg     one frame per shot
//   contact-sheet.jpg       every frame in a grid
//   index.html              storyboard with timecodes (and labels), opens in any browser
//   template.json/.md       with --template: timing and shot grammar only, one empty prompt per slot
//
// Detection uses ffmpeg's scene-change score (0-1). Lower --threshold finds softer cuts and also more
// false cuts; raise it for footage with fast motion or flashes. Dissolves and fades are not hard cuts and
// may be missed; cuts closer together than --min-shot seconds are merged.
//
// --analyze labels grammar, not content: shot size, angle, camera move, subject type, lighting, beat role and
// where on-screen text sits. It never transcribes on-screen words or describes who is in the shot. Motion
// and the colour palette are measured locally from the pixels.
//
// --template keeps only the structure (slot timing plus those labels). Each slot gets an empty "prompt" for
// your own subject; --svml then writes main.svml, main.svrun and look.svs that generate one new Seedance clip per slot.
// Run `hypit pricing main.svrun` before building: Seedance bills at least 4 seconds per clip.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
const LABELS = {
  shot_size: ["extreme-wide", "wide", "medium", "close-up", "extreme-close-up"],
  angle: ["eye-level", "high", "low", "overhead", "aerial", "pov"],
  camera_move: ["static", "handheld", "pan", "tilt", "push-in", "pull-out", "tracking", "orbit", "zoom", "unclear"],
  subject: ["person", "people", "food-drink", "interior", "architecture", "landscape-cityscape", "vehicle", "product", "graphic-card", "other"],
  lighting: ["daylight", "golden-hour", "blue-hour", "night", "overcast", "interior-warm", "interior-cool", "mixed"],
  beat: ["hook", "establishing", "detail", "action", "transition", "reveal", "cta", "other"],
  text_role: ["none", "title", "caption", "label", "logo-cta"],
  text_position: ["none", "top", "center", "bottom"],
};

function usage(message) {
  if (message) console.error(`shot-list: ${message}\n`);
  console.error("Usage: node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]\n" +
    "                     [--frame middle|first|last] [--width 540] [--columns 6]\n" +
    "                     [--analyze [--model <openrouter model>] [--concurrency 2]] [--template]\n" +
    "       node tools/shot-list.mjs --svml <filled-template.json> [--out <dir>]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { threshold: 0.3, minShot: 0.25, frame: "middle", width: 540, columns: 6,
    analyze: false, template: false, model: "google/gemini-2.5-flash", concurrency: 2 };
  const values = { "--out": "out", "--threshold": "threshold", "--min-shot": "minShot", "--frame": "frame", "--width": "width",
    "--columns": "columns", "--model": "model", "--concurrency": "concurrency", "--svml": "svml" };
  const strings = new Set(["out", "frame", "model", "svml"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--analyze" || arg === "--template") {
      options[arg.slice(2)] = true;
    } else if (values[arg]) {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      options[values[arg]] = strings.has(values[arg]) ? value : Number(value);
    } else if (arg.startsWith("--")) {
      usage(`unknown option ${arg}`);
    } else if (options.video === undefined) {
      options.video = arg;
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  if (options.svml !== undefined) {
    if (options.video !== undefined) usage("--svml takes a template, not a video");
    return options;
  }
  if (!options.video) usage("a video file is required");
  if (!(options.threshold > 0 && options.threshold < 1)) usage("--threshold must be between 0 and 1");
  if (!(options.minShot >= 0)) usage("--min-shot must be zero or more seconds");
  if (!["middle", "first", "last"].includes(options.frame)) usage("--frame must be middle, first or last");
  if (!(Number.isInteger(options.width) && options.width >= 64)) usage("--width must be a whole number of pixels, at least 64");
  if (!(Number.isInteger(options.columns) && options.columns >= 1)) usage("--columns must be a whole number");
  if (!(Number.isInteger(options.concurrency) && options.concurrency >= 1)) usage("--concurrency must be a whole number");
  if (options.analyze && !process.env.OPENROUTER_API_KEY) usage("--analyze needs the OPENROUTER_API_KEY environment variable");
  return options;
}

function run(command, args, encoding = "utf8") {
  const result = spawnSync(command, args, { encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start (${result.error.message}); install ffmpeg and put it on PATH`);
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim().split("\n").slice(-3).join(" ")}`);
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

const round = (n) => Math.round(n * 1000) / 1000;

// ---------- analysis ----------

/** One frame at `seconds`, scaled, as encoded image bytes or raw pixels. */
function grab(video, seconds, filter, format) {
  const output = format === "jpeg" ? ["-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4"] : ["-f", "rawvideo", "-pix_fmt", format];
  return run("ffmpeg", ["-hide_banner", "-v", "error", "-ss", seconds.toFixed(3), "-i", video, "-frames:v", "1",
    "-vf", filter, ...output, "-"], "buffer").stdout;
}

/** Mean absolute grey-level change across the shot (0-255); higher means more movement. */
function motionScore(video, times) {
  const frames = times.map((t) => grab(video, t, "scale=72:128", "gray"));
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    let sum = 0;
    for (let p = 0; p < frames[i].length; p++) sum += Math.abs(frames[i][p] - frames[i - 1][p]);
    total += sum / frames[i].length;
  }
  return round(total / (frames.length - 1));
}

/** Three dominant colours of the middle frame, by a small deterministic k-means. */
function palette(video, seconds) {
  const raw = grab(video, seconds, "scale=24:42", "rgb24");
  const pixels = [];
  for (let i = 0; i + 2 < raw.length; i += 3) pixels.push([raw[i], raw[i + 1], raw[i + 2]]);
  const brightness = (p) => p[0] + p[1] + p[2];
  const sorted = [...pixels].sort((a, b) => brightness(a) - brightness(b));
  let centres = [sorted[Math.floor(sorted.length / 6)], sorted[Math.floor(sorted.length / 2)], sorted[Math.floor((sorted.length * 5) / 6)]];
  let groups = [];
  for (let iteration = 0; iteration < 8; iteration++) {
    groups = centres.map(() => []);
    for (const p of pixels) {
      let best = 0, bestDistance = Infinity;
      centres.forEach((c, k) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bestDistance) { bestDistance = d; best = k; }
      });
      groups[best].push(p);
    }
    centres = groups.map((g, k) => g.length ? [0, 1, 2].map((ch) => g.reduce((s, p) => s + p[ch], 0) / g.length) : centres[k]);
  }
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  return centres.map((c, k) => ({ c, n: groups[k].length })).sort((a, b) => b.n - a.n).map((e) => hex(e.c));
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["shot_size", "angle", "camera_move", "subject", "person_on_screen", "lighting", "beat", "text_role", "text_position"],
  properties: {
    shot_size: { type: "string", enum: LABELS.shot_size },
    angle: { type: "string", enum: LABELS.angle },
    camera_move: { type: "string", enum: LABELS.camera_move },
    subject: { type: "string", enum: LABELS.subject },
    person_on_screen: { type: "boolean" },
    lighting: { type: "string", enum: LABELS.lighting },
    beat: { type: "string", enum: LABELS.beat },
    text_role: { type: "string", enum: LABELS.text_role },
    text_position: { type: "string", enum: LABELS.text_position },
  },
};

async function labelShot(frames, shot, total, model) {
  const text = `You label the visual grammar of one shot (number ${shot.index} of ${total}, ${shot.duration.toFixed(2)}s) from a short
vertical video, for an editor's pacing study. The three images are the shot's start, middle and end.
Infer camera_move from how the view changes across them. beat is the shot's role in the edit (shot 1 is usually the hook).
text_role and text_position describe any overlaid text by role and placement only.
Return only the labels. Do not transcribe on-screen words, name people or brands, or describe who appears.`;
  const body = {
    model,
    messages: [{ role: "user", content: [{ type: "text", text },
      ...frames.map((jpeg) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } }))] }],
    response_format: { type: "json_schema", json_schema: { name: "shot_labels", strict: true, schema: SCHEMA } },
    temperature: 0,
  };
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(OPENROUTER, { method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" } });
    const json = await response.json().catch(() => ({}));
    if (response.ok) {
      const content = json.choices?.[0]?.message?.content ?? "";
      const labels = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
      for (const [key, allowed] of Object.entries(LABELS)) {
        if (key in labels && !allowed.includes(labels[key])) throw new Error(`model returned ${key}=${labels[key]}`);
      }
      return { labels, cost: json.usage?.cost ?? 0 };
    }
    if (attempt >= 6 || ![408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${json.error?.message ?? "no message"}`);
    }
    // Rate limits come in bursts: honour Retry-After, otherwise back off exponentially with jitter.
    const retryAfter = Number(response.headers.get("retry-after")) * 1000;
    const wait = retryAfter > 0 ? retryAfter : Math.min(20_000, 1000 * 2 ** attempt) + Math.random() * 1000;
    await new Promise((done) => setTimeout(done, wait));
  }
}

async function analyse(video, shots, fps, options) {
  const oneFrame = 1 / fps;
  let cost = 0, failures = 0, next = 0;
  async function worker() {
    while (next < shots.length) {
      const shot = shots[next++];
      const times = [Math.min(shot.start + oneFrame, shot.end - oneFrame), (shot.start + shot.end) / 2, Math.max(shot.end - 2 * oneFrame, shot.start)];
      shot.motion = motionScore(video, times);
      shot.palette = palette(video, times[1]);
      try {
        const result = await labelShot(times.map((t) => grab(video, t, "scale=384:-2", "jpeg")), shot, shots.length, options.model);
        Object.assign(shot, result.labels);
        cost += result.cost;
      } catch (error) {
        failures++;
        shot.analysisError = error.message;
        console.error(`  shot ${shot.index}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, shots.length) }, worker));
  return { cost, failures };
}

function tally(shots, key) {
  const counts = {};
  for (const shot of shots) if (shot[key] !== undefined) counts[shot[key]] = (counts[shot[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

// ---------- template ----------

const GRAMMAR = ["beat", "shot_size", "angle", "camera_move", "person_on_screen", "text_role", "text_position"];

function writeTemplate(out, summary, shots) {
  const template = {
    format: "shot-list.template@1",
    note: "Structure only: slot timing and shot grammar. Write every prompt yourself, about your own subject; nothing here describes the source's content.",
    fps: summary.fps, aspectRatio: summary.aspectRatio, duration: summary.duration,
    seedance: { model: "mini", resolution: "720p" },
    slots: shots.map((s) => ({ slot: s.index, start: round(s.start), duration: round(s.duration),
      ...Object.fromEntries(GRAMMAR.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])), prompt: "" })),
  };
  writeFileSync(join(out, "template.json"), `${JSON.stringify(template, null, 2)}\n`);
  const cell = (s, k) => (s[k] === undefined ? "" : String(s[k]));
  writeFileSync(join(out, "template.md"), [
    `# Pacing template (${summary.shots} slots, ${summary.duration}s, ${summary.aspectRatio})`, "",
    "Structure only. Fill each slot's `prompt` in template.json with your own subject, then run",
    "`node tools/shot-list.mjs --svml template.json` to write a Hypit project that generates new shots.", "",
    "| Slot | Start | Length | Beat | Size | Angle | Move | Person | Text |", "|---|---|---|---|---|---|---|---|---|",
    ...template.slots.map((s) => `| ${s.slot} | ${s.start.toFixed(2)}s | ${s.duration.toFixed(2)}s | ${cell(s, "beat")} | ${cell(s, "shot_size")} | ${cell(s, "angle")} | ${cell(s, "camera_move")} | ${cell(s, "person_on_screen")} | ${s.text_role && s.text_role !== "none" ? `${s.text_role} (${s.text_position})` : ""} |`),
    "",
  ].join("\n"));
}

/** Text safe inside an SVML text:Value body. */
function svmlText(text) {
  return String(text).replace(/[{}]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

function writeSvml(templatePath, outOption) {
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  if (template.format !== "shot-list.template@1") throw new Error(`${templatePath} is not a shot-list template`);
  const empty = template.slots.filter((s) => !String(s.prompt ?? "").trim()).map((s) => s.slot);
  if (empty.length) throw new Error(`fill the prompt of slot${empty.length > 1 ? "s" : ""} ${empty.join(", ")} first`);
  const fps = Math.round(template.fps ?? 30);
  const [rw, rh] = String(template.aspectRatio ?? "9:16").split(":").map(Number);
  const portrait = rh >= rw;
  const ratio = portrait ? "9:16" : "16:9";
  const canvas = portrait ? [1080, 1920] : [1920, 1080];
  const variant = template.seedance?.model ?? "mini";
  const resolution = template.seedance?.resolution ?? "720p";
  const pad = (n) => String(n).padStart(2, "0");
  let frame = 0, billed = 0;
  const slots = template.slots.map((s) => {
    const frames = Math.max(1, Math.round(s.duration * fps));
    const clip = Math.min(15, Math.max(4, Math.ceil(s.duration)));
    billed += clip;
    const camera = [s.shot_size && `${s.shot_size} shot`, s.angle && `${s.angle} angle`, s.camera_move && s.camera_move !== "unclear" && `${s.camera_move} camera`]
      .filter(Boolean).join(", ");
    const prompt = svmlText(s.prompt);
    const slot = { id: `slot-${pad(s.slot)}`, from: frame, until: frame + frames, clip, prompt: /[.!?]$/.test(prompt) ? prompt : `${prompt}.`, camera };
    frame += frames;
    return slot;
  });
  const lines = [
    '<?svml using="@hypit/markup@1"?>', "<svml>",
    ...[["text", "@hypit/text@1"], ["seedance", "@hypit/seedance@1"], ["mediaop", "@hypit/media-operations@1"], ["time", "@hypit/timeline-author@1"],
      ["space", "@hypit/spatial@1"], ["visual", "@hypit/visual-track@1"], ["film", "@hypit/film@1"], ["html", "@hypit/html-video@1"]]
      .map(([as, from]) => `  <import as="${as}" from="${from}"/>`),
    '  <import as="look" source="./look.svs"/>',
    "",
    `  <!-- Generated by tools/shot-list.mjs from ${basename(templatePath)}: one new Seedance clip per slot, cut to the slot's length. -->`,
    `  <space:Canvas id="canvas" width="${canvas[0]}" height="${canvas[1]}"/>`,
    `  <time:Clock id="clock" frame-rate="${fps}"/>`,
    '  <space:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>',
  ];
  for (const s of slots) {
    lines.push("", `  <text:Value id="${s.id}-prompt">`, `    ${s.prompt}${s.camera ? `\n    Camera: ${s.camera}.` : ""}`,
      "    Photorealistic, no on-screen text, no logos.", "  </text:Value>",
      `  <seedance:TextVideo id="${s.id}" model="${variant}" prompt={${s.id}-prompt} duration="${s.clip}"`,
      `    resolution="${resolution}" aspect-ratio="${ratio}" generate-audio="false"/>`,
      `  <mediaop:Normalize id="${s.id}-media" source={${s.id}.video} clock={clock} video="primary-moving" audio="none" span-authority="video"/>`);
  }
  lines.push("", `  <time:Timeline id="story" clock={clock} end="${frame}f">`,
    ...slots.map((s) => `    <time:Window id="${s.id}" from="${s.from}f" until="${s.until}f"/>`), "  </time:Timeline>",
    '  <visual:Track id="picture" timeline={story.timeline}>',
    ...slots.map((s) => `    <visual:Clip id="${s.id}-clip" media={${s.id}-media.media} during={story.${s.id}} frame={full} z="0" fit="cover"/>`),
    "  </visual:Track>",
    '  <film:Film id="main" canvas={canvas.canvas} timeline={story.timeline} appearance={look.film.main}>', "    <film:Track source={picture.visual}/>", "  </film:Film>",
    '  <html:Video id="final" composition={main.composition} timeline={story.timeline}/>', "</svml>", "");
  const out = resolve(outOption ?? ".");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "main.svml"), lines.join("\n"));
  writeFileSync(join(out, "look.svs"), '<?svml using="@hypit/recipe@1"?>\n<sheet version="1">\n  film.main { background: #000000; }\n</sheet>\n');
  writeFileSync(join(out, "main.svrun"), '<?svml using="@hypit/markup/run@1"?>\n<svrun version="1">\n  <author source="./main.svml"/>\n  <target output="final.video"/>\n</svrun>\n');
  console.log(`Wrote ${out}/main.svml, main.svrun and look.svs: ${slots.length} slots, ${round(frame / fps)}s at ${fps} fps.`);
  console.log(`Seedance ${variant} ${resolution} will bill about ${billed}s of video (4s minimum per clip). Check with: hypit pricing main.svrun`);
}

// ---------- main ----------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.svml !== undefined) return writeSvml(resolve(options.svml), options.out);
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

  let analysis;
  if (options.analyze) {
    console.log(`Labelling ${shots.length} shots with ${options.model}...`);
    analysis = await analyse(video, shots, info.fps, options);
  }

  const record = shots.map((s) => ({
    shot: s.index, start: round(s.start), end: round(s.end), duration: round(s.duration),
    startTimecode: timecode(s.start, info.fps), endTimecode: timecode(s.end, info.fps), frameAt: round(s.frameAt), frame: s.frame,
    ...(options.analyze ? Object.fromEntries([...Object.keys(SCHEMA.properties), "motion", "palette", "analysisError"]
      .filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) : {}),
  }));
  const durations = shots.map((s) => s.duration);
  const divisor = (a, b) => (b ? divisor(b, a % b) : a);
  const g = divisor(info.width, info.height);
  const summary = {
    video: basename(video), duration: round(info.duration), fps: round(info.fps), resolution: `${info.width}x${info.height}`,
    aspectRatio: `${info.width / g}:${info.height / g}`, threshold: options.threshold, shots: shots.length,
    averageShot: round(info.duration / shots.length), shortestShot: round(Math.min(...durations)), longestShot: round(Math.max(...durations)),
    firstCut: shots.length > 1 ? round(shots[1].start) : null,
  };
  if (analysis) {
    const labelled = shots.filter((s) => !s.analysisError);
    Object.assign(summary, {
      model: options.model, analysisCost: round(analysis.cost),
      personOnScreenShare: labelled.length ? round(labelled.filter((s) => s.person_on_screen).length / labelled.length) : null,
      textOverlayShare: labelled.length ? round(labelled.filter((s) => s.text_role && s.text_role !== "none").length / labelled.length) : null,
      averageMotion: round(shots.reduce((sum, s) => sum + s.motion, 0) / shots.length),
      shotSizes: tally(shots, "shot_size"), cameraMoves: tally(shots, "camera_move"), subjects: tally(shots, "subject"),
    });
  }

  writeFileSync(join(out, "shots.json"), `${JSON.stringify({ summary, shots: record }, null, 2)}\n`);
  const extra = options.analyze ? ["beat", "shot_size", "angle", "camera_move", "subject", "person_on_screen", "lighting", "text_role", "text_position", "motion", "palette"] : [];
  const csvCell = (v) => (Array.isArray(v) ? v.join(" ") : v ?? "");
  writeFileSync(join(out, "shots.csv"), [["shot", "start", "end", "duration", "start_timecode", "end_timecode", "frame", ...extra].join(","),
    ...record.map((r) => [r.shot, r.start, r.end, r.duration, r.startTimecode, r.endTimecode, r.frame, ...extra.map((k) => csvCell(r[k]))].join(","))].join("\n") + "\n");

  const labelsHtml = (r) => !options.analyze ? "" : r.analysisError ? "<br><span>not labelled</span>"
    : `<br><span>${escapeHtml([r.beat, r.shot_size, r.angle, r.camera_move].join(" · "))}<br>${escapeHtml(r.subject)}${r.person_on_screen ? " · person" : ""}` +
      `${r.text_role !== "none" ? ` · ${escapeHtml(r.text_role)} text` : ""}</span><br>${r.palette.map((c) => `<i style="background:${c}"></i>`).join("")}`;
  writeFileSync(join(out, "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shot list: ${escapeHtml(summary.video)}</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.4 system-ui, sans-serif; background: #111; color: #eee; }
  h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 16px; color: #aaa; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  figure { margin: 0; } img { width: 100%; display: block; border-radius: 6px; }
  figcaption { margin-top: 4px; font-variant-numeric: tabular-nums; } b { color: #fff; } span { color: #999; font-size: 12px; }
  i { display: inline-block; width: 16px; height: 10px; margin: 4px 3px 0 0; border-radius: 2px; }
</style></head><body>
<h1>${escapeHtml(summary.video)}</h1>
<p>${summary.shots} shots in ${summary.duration}s · average ${summary.averageShot}s · first cut ${summary.firstCut ?? "none"}s · ${summary.resolution} at ${summary.fps} fps · scene threshold ${summary.threshold}${
  analysis ? ` · person on screen in ${Math.round(summary.personOnScreenShare * 100)}% of shots · text in ${Math.round(summary.textOverlayShare * 100)}%` : ""}</p>
<div class="grid">
${record.map((r) => `  <figure><img src="${r.frame}" alt="Shot ${r.shot}" loading="lazy"><figcaption><b>#${r.shot}</b> ${r.startTimecode}<br><span>${r.duration.toFixed(2)}s</span>${labelsHtml(r)}</figcaption></figure>`).join("\n")}
</div></body></html>
`);
  if (options.template) writeTemplate(out, summary, shots);

  console.log(`${summary.shots} shots in ${summary.duration}s (average ${summary.averageShot}s, shortest ${summary.shortestShot}s, longest ${summary.longestShot}s)`);
  for (const r of record) {
    const labels = options.analyze && !r.analysisError ? `  ${r.beat} · ${r.shot_size} · ${r.angle} · ${r.camera_move} · ${r.subject}` : "";
    console.log(`  #${String(r.shot).padStart(3)}  ${r.startTimecode} → ${r.endTimecode}  ${r.duration.toFixed(2)}s  ${r.frame}${labels}`);
  }
  if (analysis) console.log(`Labelled ${shots.length - analysis.failures}/${shots.length} shots for $${analysis.cost.toFixed(4)}.`);
  console.log(`Wrote ${out}/ (shots.json, shots.csv, frames/, contact-sheet.jpg, index.html${options.template ? ", template.json, template.md" : ""})`);
  if (analysis?.failures) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`shot-list: ${error.message}`);
  process.exit(1);
});
