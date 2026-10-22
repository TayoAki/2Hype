#!/usr/bin/env node
// Shot list for any video: cut points, one frame per shot, a contact sheet and a storyboard page.
// Optional: measure picture and sound (--metrics), label each shot's grammar and the audio structure (--analyze),
// export a structure-only format template (--template), write a VIDEO_SPEC.md format spec (--spec), turn a
// filled template into a Hypit project that generates new shots (--svml), and check a render against a reference
// analysis variable by variable (--compare). Used by the video-remake skill.
// Needs ffmpeg and ffprobe on PATH; --analyze also needs OPENROUTER_API_KEY. No npm dependencies.
//
//   node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]
//                            [--frame middle|first|last] [--width 540] [--columns 6] [--metrics]
//                            [--analyze [--model google/gemini-2.5-flash] [--concurrency 2]] [--template] [--spec]
//   node tools/shot-list.mjs --svml <filled-template.json> [--group 15] [--out <dir>]
//   node tools/shot-list.mjs <render> --compare <reference shots.json> [--out <dir>]
//
// Writes into <dir> (default: <video name>-shots/):
//   shots.json, shots.csv   start, end, duration, timecodes and frame file for every shot (plus labels)
//   frames/shot-NNN.jpg     one frame per shot
//   contact-sheet.jpg       every frame in a grid
//   index.html              storyboard with timecodes (and labels), opens in any browser
//   template.json/.md       with --template: timing and shot grammar only, one empty prompt per slot
//   VIDEO_SPEC.md           with --spec: every measured value, plus empty sections for your own creative layer
//
// Detection uses ffmpeg's scene-change score (0-1). Lower --threshold finds softer cuts and also more
// false cuts; raise it for footage with fast motion or flashes. Dissolves and fades are not hard cuts and
// may be missed; cuts closer together than --min-shot seconds are merged.
//
// --metrics measures loudness (LUFS, true peak), brightness, saturation, contrast, frame-to-frame motion, repeated
// frames (judder), music tempo, cuts on the beat and cuts per five seconds with ffmpeg alone.
//
// --analyze labels grammar, not content: shot size, angle, camera move, subject type, lighting, beat role and
// where on-screen text sits, plus the audio's structure (voiceover, voice type, music genre, tempo, ending) and
// speech pace, and a paraphrased content summary: message, offers, call to action, brand positioning, cast
// archetypes and what each piece of on-screen text conveys. It keeps no transcript, lyrics or verbatim copy and no
// detailed character designs. Motion and the colour palette are measured locally from the pixels. It also labels the
// format variables a remake holds constant (people per shot, hands, medium, device, held prop, kind of setting, text
// overlaid or in the scene, a zone-by-zone layout of screens and end cards), gives recurring characters and repeated
// camera setups abstract ids (C1.., S1..), and reduces any voice to phrase timings and word counts.
//
// --own is for video the producer made or may adapt: --analyze then also keeps the full transcript (transcript.json and
// transcript.srt with word timings), each shot's exact on-screen text and a detailed description, and full character
// and brand designs; --template starts every slot prompt from its description and lists its source frame.
//
// --template keeps only the structure (slot timing in frames at the timeline rate, those labels and a "holdConstant"
// list). Each slot gets an empty "prompt" and each voice phrase an empty "line" for your own words. --svml writes main.svml, main.svrun and look.svs that generate new Seedance clips; with
// --group <seconds> neighbouring slots share one multi-shot clip, because Seedance bills at least 4 seconds per
// clip. A template may add "style" (text prepended to every clip) and "references" ([{ "path", "role",
// "personReference" }], project-relative images) and "styleByMedium". Run `hypit pricing main.svrun` before building.
//
// --compare measures a render on the reference's own slots (implies --analyze and --metrics) and writes DELTA.md
// and delta.json: every check the render misses against the reference's shots.json.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

// OPENROUTER_BASE_URL points the tool at another OpenRouter-compatible server, for example a local mock in tests.
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const OPENROUTER = `${OPENROUTER_BASE}/chat/completions`;
const TRANSCRIPTIONS = `${OPENROUTER_BASE}/audio/transcriptions`;
const LABELS = {
  shot_size: ["extreme-wide", "wide", "medium", "close-up", "extreme-close-up"],
  angle: ["eye-level", "high", "low", "overhead", "aerial", "pov"],
  camera_move: ["static", "handheld", "pan", "tilt", "push-in", "pull-out", "tracking", "orbit", "zoom", "unclear"],
  subject: ["person", "people", "food-drink", "interior", "architecture", "landscape-cityscape", "vehicle", "product", "graphic-card", "other"],
  lighting: ["daylight", "golden-hour", "blue-hour", "night", "overcast", "interior-warm", "interior-cool", "mixed"],
  beat: ["hook", "establishing", "detail", "action", "transition", "reveal", "cta", "other"],
  text_role: ["none", "title", "caption", "label", "logo-cta"],
  text_position: ["none", "top", "center", "bottom"],
  // Format variables a remake holds constant per slot (template@2).
  medium: ["live-action", "3d-animation", "stop-motion", "2d-animation", "motion-graphics", "mixed"],
  device: ["none", "held-up", "screen-closeup", "in-background"],
  held_prop: ["none", "phone", "product", "food", "bag-basket-cart", "tool", "other"],
  setting: ["retail-interior", "home-interior", "other-interior", "exterior-urban", "exterior-nature", "tabletop-studio", "plain-backdrop", "graphic", "other"],
  text_layer: ["none", "overlay", "in-world", "both"],
};
// Per-slot fields the template asks a remake to keep; --compare checks each one.
const HOLD = ["people_count", "hands_in_frame", "medium", "device", "held_prop", "setting", "text_layer"];

function usage(message) {
  if (message) console.error(`shot-list: ${message}\n`);
  console.error("Usage: node tools/shot-list.mjs <video> [--out <dir>] [--threshold 0.3] [--min-shot 0.25]\n" +
    "                     [--frame middle|first|last] [--width 540] [--columns 6] [--metrics]\n" +
    "                     [--analyze [--model <openrouter model>] [--fallback-model <model>] [--concurrency 2]] [--template] [--spec] [--own]\n" +
    "                     [--compare <reference shots.json>]\n" +
    "       node tools/shot-list.mjs --svml <filled-template.json> [--group 15] [--out <dir>]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { threshold: 0.3, minShot: 0.25, frame: "middle", width: 540, columns: 6,
    analyze: false, template: false, metrics: false, spec: false, own: false, model: "google/gemini-2.5-flash", fallbackModel: "openai/gpt-4.1-mini",
    concurrency: 2, group: 0 };
  const values = { "--out": "out", "--threshold": "threshold", "--min-shot": "minShot", "--frame": "frame", "--width": "width",
    "--columns": "columns", "--model": "model", "--fallback-model": "fallbackModel", "--concurrency": "concurrency", "--svml": "svml", "--group": "group", "--compare": "compare" };
  const strings = new Set(["out", "frame", "model", "fallbackModel", "svml", "compare"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") usage();
    if (["--analyze", "--template", "--metrics", "--spec", "--own"].includes(arg)) {
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
    if (!(options.group === 0 || (Number.isInteger(options.group) && options.group >= 4 && options.group <= 15))) usage("--group must be 0 or 4 to 15 seconds");
    return options;
  }
  if (!options.video) usage("a video file is required");
  if (!(options.threshold > 0 && options.threshold < 1)) usage("--threshold must be between 0 and 1");
  if (!(options.minShot >= 0)) usage("--min-shot must be zero or more seconds");
  if (!["middle", "first", "last"].includes(options.frame)) usage("--frame must be middle, first or last");
  if (!(Number.isInteger(options.width) && options.width >= 64)) usage("--width must be a whole number of pixels, at least 64");
  if (!(Number.isInteger(options.columns) && options.columns >= 1)) usage("--columns must be a whole number");
  if (!(Number.isInteger(options.concurrency) && options.concurrency >= 1)) usage("--concurrency must be a whole number");
  if (options.compare !== undefined) options.analyze = options.metrics = true;
  if (options.analyze && !process.env.OPENROUTER_API_KEY) usage("--analyze needs the OPENROUTER_API_KEY environment variable");
  if (options.spec) options.template = options.metrics = true;
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
  // A seek into the last frame or two of a file can return nothing; step back a tenth of a second at a time.
  for (let t = seconds, tries = 0; ; t = Math.max(0, t - 0.1), tries++) {
    const bytes = run("ffmpeg", ["-hide_banner", "-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1",
      "-vf", filter, ...output, "-"], "buffer").stdout;
    if (bytes.length || tries >= 3 || t === 0) return bytes;
  }
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
  required: ["shot_size", "angle", "camera_move", "subject", "person_on_screen", "lighting", "beat", "text_role", "text_position",
    "people_count", "hands_in_frame", "medium", "device", "held_prop", "setting", "text_layer", "layout_note"],
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
    people_count: { type: "integer" },
    hands_in_frame: { type: "boolean" },
    medium: { type: "string", enum: LABELS.medium },
    device: { type: "string", enum: LABELS.device },
    held_prop: { type: "string", enum: LABELS.held_prop },
    setting: { type: "string", enum: LABELS.setting },
    text_layer: { type: "string", enum: LABELS.text_layer },
    layout_note: { type: "string" },
  },
};

/** Field guide shared by both labelling prompts. */
const HOLD_GUIDE = `people_count: people or characters visible in the middle frame (partial bodies count; hands alone do not; 0 if none).
hands_in_frame: hands appear without their owner's face (a point-of-view insert). medium: how the shot was made
(3d-animation includes clay or felt looks rendered in CG). device: "screen-closeup" when a phone or screen fills much
of the frame, with or without hands; "held-up" when we see a character holding a phone or screen up; "in-background"
when a screen is visible but not the focus; "none" otherwise. held_prop: what the main subject holds. setting: the kind
of place, not which place. text_layer: whether text is laid over the picture, part of the scene (signs, screens,
packaging), both, or none. layout_note: only for screen close-ups, end cards and graphic cards, otherwise an empty
string: the arrangement by zone in at most 40 words (where the device, hands, logo, text blocks, buttons and characters
sit, their sizes, the background treatment), never the wording, names or brands.`;

const OWN_SHOT_SCHEMA = {
  ...SCHEMA, required: [...SCHEMA.required, "description", "on_screen_text"],
  properties: { ...SCHEMA.properties, description: { type: "string" }, on_screen_text: { type: "string" } },
};

async function labelShot(frames, shot, total, model, own) {
  const text = own ? `This is the producer's own video. Label the visual grammar of one shot (number ${shot.index} of ${total},
${shot.duration.toFixed(2)}s); the three images are its start, middle and end. Infer camera_move from how the view changes.
beat is the shot's role in the edit (shot 1 is usually the hook). Also give description: what happens in the shot in
at most 45 words (characters, action, setting, framing, colours), detailed enough to generate a matching new take, and
on_screen_text: every overlaid word exactly as shown, lines separated by " / " (empty string if none).
${HOLD_GUIDE}` : `You label the visual grammar of one shot (number ${shot.index} of ${total}, ${shot.duration.toFixed(2)}s) from a short
video, for an editor's format study. The three images are the shot's start, middle and end.
Infer camera_move from how the view changes across them. beat is the shot's role in the edit (shot 1 is usually the hook).
text_role and text_position describe any overlaid text by role and placement only.
${HOLD_GUIDE}
Return only the labels. Do not transcribe on-screen words, name people or brands, or describe who appears.`;
  const body = {
    model,
    messages: [{ role: "user", content: [{ type: "text", text },
      ...frames.map((jpeg) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } }))] }],
    response_format: { type: "json_schema", json_schema: { name: own ? "own_shot_labels" : "shot_labels", strict: true, schema: own ? OWN_SHOT_SCHEMA : SCHEMA } },
    temperature: 0,
  };
  const json = await postOpenRouter(OPENROUTER, body);
  const content = json.choices?.[0]?.message?.content ?? "";
  let labels;
  try {
    labels = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  } catch {
    const choice = json.choices?.[0] ?? {};
    throw new Error(`unreadable labels (finish ${choice.finish_reason ?? "?"}${choice.native_finish_reason ? `/${choice.native_finish_reason}` : ""}): ${JSON.stringify(content.slice(0, 160))}`);
  }
  for (const [key, allowed] of Object.entries(LABELS)) {
    if (key in labels && !allowed.includes(labels[key])) throw new Error(`model returned ${key}=${labels[key]}`);
  }
  if (!(Number.isInteger(labels.people_count) && labels.people_count >= 0)) throw new Error(`model returned people_count=${labels.people_count}`);
  // Hands holding a phone with no face in frame is a screen insert, whichever way the model phrased it.
  if (labels.device === "held-up" && labels.hands_in_frame && labels.people_count === 0) labels.device = "screen-closeup";
  labels.layout_note = words(labels.layout_note, 40);
  // Layout is zones, never wording: drop anything the model quoted from a third-party screen or card.
  if (!own) labels.layout_note = labels.layout_note.replace(/["“'‘][^"“”'‘’]{1,40}["”'’]/g, "text");
  return { labels, cost: json.usage?.cost ?? 0 };
}

const CONTINUITY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["shots"],
  properties: { shots: { type: "array", items: { type: "object", additionalProperties: false, required: ["shot", "characters", "setup"],
    properties: { shot: { type: "integer" }, characters: { type: "array", items: { type: "string" } }, setup: { type: "string" } } } } },
};

/**
 * Who recurs and which camera setups repeat, as abstract ids across the whole video (C1, C2... and S1, S2...).
 * Callbacks to a home setup and a recurring pair are format devices; the ids describe no one.
 */
async function continuity(video, shots, model) {
  const content = [{ type: "text", text: `These are the middle frames of every shot of one video, in order. Give each recurring
character an id C1, C2, ... in order of first appearance and list the ids visible in each shot (leave out background
extras; use "hands" for hands without a face). Give each camera setup an id S1, S2, ...: two shots share a setup only
when they show the same location from the same camera position and framing (a closer cut-in, a reverse angle or a new
place is a new setup). Return every shot, ids only.` }];
  for (const s of shots) {
    content.push({ type: "text", text: `Shot ${s.index}:` },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${grab(video, (s.start + s.end) / 2, "scale=320:-2", "jpeg").toString("base64")}` } });
  }
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "continuity", strict: true, schema: CONTINUITY_SCHEMA } } });
  const raw = json.choices?.[0]?.message?.content ?? "";
  const result = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  for (const entry of result.shots) {
    const shot = shots.find((s) => s.index === entry.shot);
    if (!shot) continue;
    shot.characters = entry.characters.map((c) => String(c).trim()).filter((c) => /^(C\d+|hands)$/.test(c));
    if (/^S\d+$/.test(entry.setup)) shot.setup = entry.setup;
  }
  return { cost: json.usage?.cost ?? 0 };
}

/** Slot lists for every id that appears in more than one shot: the callbacks a remake should keep. */
function recurrence(shots, key) {
  const map = {};
  for (const s of shots) for (const id of [s[key]].flat().filter(Boolean)) (map[id] ??= []).push(s.index);
  return Object.fromEntries(Object.entries(map).filter(([id, slots]) => slots.length > 1 && id !== "hands"));
}

async function postOpenRouter(url, body) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" } });
    } catch (error) {
      // Dropped connections and timeouts are as transient as a 5xx; retry them the same way.
      if (attempt >= 6) throw new Error(`OpenRouter request failed after ${attempt} attempts: ${error.cause?.code ?? error.message}`);
      await new Promise((done) => setTimeout(done, Math.min(20_000, 1000 * 2 ** attempt) + Math.random() * 1000));
      continue;
    }
    const json = await response.json().catch(() => ({}));
    // OpenRouter can answer 200 with an error body (a provider outage, or the provider refusing to answer).
    if (response.ok && !json.error) return json;
    if (response.ok) {
      const blocked = /block/i.test(json.error.message ?? "");
      if (blocked || attempt >= 6) throw new Error(`OpenRouter: ${json.error.message ?? "error"}`);
      await new Promise((done) => setTimeout(done, Math.min(20_000, 1000 * 2 ** attempt)));
      continue;
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
      const frames = times.map((t) => grab(video, t, "scale=384:-2", "jpeg"));
      // A truncated, off-schema or blocked answer gets one more try on the fallback model before the shot is skipped.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const result = await labelShot(frames, shot, shots.length, attempt === 1 ? options.model : options.fallbackModel, options.own);
          Object.assign(shot, result.labels);
          cost += result.cost;
          break;
        } catch (error) {
          if (attempt < 2) continue;
          failures++;
          shot.analysisError = error.message;
          console.error(`  shot ${shot.index}: ${error.message}`);
        }
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

// ---------- metrics ----------

function hasAudio(video) {
  return run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", video]).stdout.trim() !== "";
}

const median = (values) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
const percentile = (values, p) => { const v = [...values].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null; };
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Loudness, picture statistics and pacing, measured with ffmpeg alone. */
function measureMetrics(video, shots, info) {
  const metrics = {};
  if (hasAudio(video)) {
    const { stderr } = run("ffmpeg", ["-hide_banner", "-nostats", "-i", video, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
    const loud = JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1));
    Object.assign(metrics, { loudnessLufs: Number(loud.input_i), truePeakDb: Number(loud.input_tp), loudnessRangeLu: Number(loud.input_lra) });
  }
  const { stdout } = run("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-an", "-vf", "scale=320:-2,signalstats,metadata=print:file=-", "-f", "null", "-"]);
  const frames = [];
  for (const line of stdout.split("\n")) {
    const time = /pts_time:([0-9.]+)/.exec(line);
    if (time) { frames.push({ t: Number(time[1]) }); continue; }
    const stat = /lavfi\.signalstats\.(\w+)=([0-9.]+)/.exec(line);
    if (stat && frames.length) frames.at(-1)[stat[1]] = Number(stat[2]);
  }
  // A cut's first frame differs from the last frame of the previous shot; leave those out of motion.
  const cutFrames = shots.slice(1).map((s) => s.start);
  const moving = frames.slice(1).filter((f) => !cutFrames.some((c) => f.t >= c - 0.5 / info.fps && f.t < c + 1.5 / info.fps)).map((f) => f.YDIF);
  const span = 5, buckets = Array.from({ length: Math.ceil(info.duration / span) }, () => 0);
  for (const shot of shots) buckets[Math.min(buckets.length - 1, Math.floor(shot.start / span))]++;
  // A repeated frame in moving footage (a near-still frame between two moving ones) is judder, typically from
  // putting 24 fps footage on a 30 fps timeline.
  const repeated = frames.slice(1, -1).filter((f, i) => {
    const before = frames[i].YDIF, after = frames[i + 2].YDIF;
    return f.YDIF < 0.35 && Math.min(before, after) > 0.6 && f.YDIF < 0.2 * Math.max(before, after);
  }).length;
  Object.assign(metrics, {
    brightness: round(mean(frames.map((f) => f.YAVG))), saturation: round(mean(frames.map((f) => f.SATAVG))),
    contrast: round(mean(frames.map((f) => f.YHIGH - f.YLOW))),
    motionMedian: round(median(moving)), motionP90: round(percentile(moving, 0.9)), repeatedFrames: repeated,
    cutsPerSecond: round((shots.length - 1) / info.duration), shotsPerFiveSeconds: buckets,
  });
  if (metrics.loudnessLufs !== undefined) Object.assign(metrics, measureBeat(video, cutFrames));
  return metrics;
}

/**
 * Music tempo and how many cuts land on the beat, from an onset envelope (energy rise per 11.6 ms hop),
 * its autocorrelation (70-180 BPM, weighted towards 120) and the best-fitting beat phase. ffmpeg only.
 */
function measureBeat(video, cuts) {
  const rate = 11025, hop = 128, hopSeconds = hop / rate;
  const pcm = run("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], "buffer").stdout;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const count = Math.floor(samples.length / hop);
  if (count < 200) return {};
  const envelope = new Float64Array(count);
  let previous = 0;
  for (let i = 0; i < count; i++) {
    let energy = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) energy += samples[k] * samples[k];
    const level = Math.log1p(energy / hop);
    envelope[i] = Math.max(0, level - previous);
    previous = level;
  }
  const average = envelope.reduce((a, b) => a + b, 0) / count;
  const centred = envelope.map((v) => v - average);
  const minLag = Math.floor(60 / 180 / hopSeconds), maxLag = Math.ceil(60 / 70 / hopSeconds);
  const score = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < count; i++) sum += centred[i] * centred[i - lag];
    const bpm = 60 / (lag * hopSeconds);
    score[lag] = (sum / (count - lag)) * Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.0) ** 2);
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;
  // Parabolic refinement between neighbouring lags.
  const [a, b, c] = [score[best - 1] ?? score[best], score[best], score[best + 1] ?? score[best]];
  const period = best + (a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
  let phase = 0, phaseScore = -Infinity;
  for (let offset = 0; offset < period; offset += 1) {
    let sum = 0;
    for (let t = offset; t < count; t += period) sum += Math.max(envelope[Math.floor(t)], envelope[Math.min(count - 1, Math.floor(t) + 1)]);
    if (sum > phaseScore) { phaseScore = sum; phase = offset; }
  }
  const beatSeconds = period * hopSeconds, firstBeat = phase * hopSeconds;
  const distance = (t, step) => { const x = ((t - firstBeat) % step + step) % step; return Math.min(x, step - x); };
  return {
    tempoBpm: round(60 / beatSeconds), firstBeat: round(firstBeat),
    cutsOnBeat: cuts.filter((t) => distance(t, beatSeconds) <= 0.07).length,
    cutsOnHalfBeat: cuts.filter((t) => distance(t, beatSeconds / 2) <= 0.07).length, cutsMeasured: cuts.length,
  };
}

const AUDIO_LABELS = {
  voice_gender: ["female", "male", "mixed", "none"], voice_age: ["child", "young-adult", "adult", "older", "none"],
  voice_energy: ["calm", "warm", "upbeat", "high", "none"], ending: ["button", "fade", "hard-cut", "voiceover-tag", "silence", "other"],
  voice_delivery: ["spoken", "sung", "chant-rap", "mixed", "none"],
};
const AUDIO_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["voiceover", "voice_gender", "voice_age", "voice_energy", "voice_delivery", "music", "music_vocals", "music_ducks_under_voice",
    "music_genre", "music_mood", "bpm_estimate", "sfx", "ending"],
  properties: {
    voiceover: { type: "boolean" }, music: { type: "boolean" }, music_vocals: { type: "boolean" }, sfx: { type: "boolean" },
    music_ducks_under_voice: { type: "boolean" },
    music_genre: { type: "string" }, music_mood: { type: "string" }, bpm_estimate: { type: "number" },
    ...Object.fromEntries(Object.entries(AUDIO_LABELS).map(([k, values]) => [k, { type: "string", enum: values }])),
  },
};

/**
 * Audio structure labels and, when there is a voice (spoken or sung), its pace and word timings. Only own-content mode
 * keeps the transcript; otherwise each word is reduced to its start and end and the text is discarded.
 */
async function analyseAudio(video, model, own) {
  const mp3 = run("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"], "buffer").stdout;
  const data = mp3.toString("base64");
  const text = `Label the structure of this advert or short-video soundtrack for an editor's format study.
voiceover is any voice that carries the message, spoken or sung; voice_delivery says which. music_vocals is singing
that is part of the music bed. music_ducks_under_voice is true when the music drops in level while the voice speaks.
music_genre and music_mood are at most three words each. bpm_estimate is the music tempo (0 if there is no music).
Do not transcribe speech or lyrics, and do not name songs, artists, people or brands.`;
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text }, { type: "input_audio", input_audio: { data, format: "mp3" } }] }],
    response_format: { type: "json_schema", json_schema: { name: "audio_labels", strict: true, schema: AUDIO_SCHEMA } } });
  const content = json.choices?.[0]?.message?.content ?? "";
  const labels = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
  let cost = json.usage?.cost ?? 0, pace = null, transcript = null, wordTimes = null;
  if (labels.voiceover || labels.music_vocals || own) {
    const stt = await postOpenRouter(TRANSCRIPTIONS, { model: "elevenlabs/scribe-v2",
      input_audio: { data, format: "mp3" }, response_format: "verbose_json", timestamp_granularities: ["word"] });
    const words = (stt.words ?? []).filter((w) => (w.type ?? "word") === "word" && String(w.word).trim());
    if (words.length) {
      const gaps = words.slice(1).map((w, i) => w.start - words[i].end);
      const spoken = words.at(-1).end - words[0].start;
      pace = { words: words.length, speechStart: round(words[0].start), speechEnd: round(words.at(-1).end),
        wordsPerSecond: round(words.length / spoken), pausesOver300ms: gaps.filter((g) => g > 0.3).length, longestPause: round(Math.max(0, ...gaps)) };
      wordTimes = words.map((w) => ({ start: round(w.start), end: round(w.end) }));
      if (own) transcript = words.map((w) => ({ word: String(w.word).trim(), start: round(w.start), end: round(w.end) }));
    }
    cost += stt.usage?.cost ?? 0;
  }
  return { labels, pace, transcript, wordTimes, cost };
}

/** Voice phrases from word timings alone: a new phrase starts after a pause longer than 0.35 s. */
function voicePhrases(wordTimes, shots) {
  const phrases = [];
  for (const w of wordTimes) {
    const last = phrases.at(-1);
    if (last && w.start - last.end <= 0.35) { last.end = w.end; last.words++; } else phrases.push({ start: w.start, end: w.end, words: 1 });
  }
  return phrases.map((p, i) => ({ phrase: i + 1, start: round(p.start), end: round(p.end), words: p.words,
    slots: shots.filter((s) => s.end > p.start && s.start < p.end).map((s) => s.index) }));
}

/** How much voice falls inside each shot: words (by midpoint) and seconds of overlap. */
function voicePerShot(wordTimes, shots) {
  for (const s of shots) {
    const inside = wordTimes.filter((w) => (w.start + w.end) / 2 >= s.start && (w.start + w.end) / 2 < s.end);
    s.vo_words = inside.length;
    s.vo_seconds = round(wordTimes.reduce((sum, w) => sum + Math.max(0, Math.min(w.end, s.end) - Math.max(w.start, s.start)), 0));
  }
}

/** Transcript lines: break at sentence ends and at pauses longer than half a second. */
function transcriptLines(words) {
  const lines = [];
  let current = [];
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    if (!next || /[.!?]$/.test(w.word) || next.start - w.end > 0.5) {
      lines.push({ start: current[0].start, end: current.at(-1).end, text: current.map((x) => x.word).join(" ") });
      current = [];
    }
  });
  return lines;
}

function srtTime(seconds) {
  const ms = Math.round(seconds * 1000), pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

const CONTENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["message_summary", "offers_or_claims", "call_to_action", "tone", "brand", "characters", "on_screen_text", "music_theme"],
  properties: {
    message_summary: { type: "string" }, call_to_action: { type: "string" }, tone: { type: "string" }, music_theme: { type: "string" },
    offers_or_claims: { type: "array", items: { type: "string" } },
    brand: { type: "object", additionalProperties: false, required: ["name", "positioning", "visual_identity"],
      properties: { name: { type: "string" }, positioning: { type: "string" }, visual_identity: { type: "string" } } },
    characters: { type: "array", items: { type: "object", additionalProperties: false, required: ["role", "archetype", "prominence"],
      properties: { role: { type: "string" }, archetype: { type: "string" }, prominence: { type: "string", enum: ["lead", "supporting", "background"] } } } },
    on_screen_text: { type: "array", items: { type: "object", additionalProperties: false, required: ["role", "purpose"],
      properties: { role: { type: "string", enum: LABELS.text_role }, purpose: { type: "string" } } } },
  },
};

/** Clip a free-text field to a word budget so summaries stay summaries. */
const words = (text, limit) => String(text ?? "").split(/\s+/).filter(Boolean).slice(0, limit).join(" ");

/**
 * What the reference says and shows, paraphrased: message, offers, call to action, brand positioning, cast archetypes
 * and the purpose of its on-screen text. For understanding and contrast; it holds no transcript, lyrics or copy.
 */
const OWN_CONTENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["message_summary", "offers_or_claims", "call_to_action", "tone", "brand", "characters", "music_theme"],
  properties: {
    message_summary: { type: "string" }, call_to_action: { type: "string" }, tone: { type: "string" }, music_theme: { type: "string" },
    offers_or_claims: { type: "array", items: { type: "string" } },
    brand: { type: "object", additionalProperties: false, required: ["name", "tagline", "positioning", "visual_identity"],
      properties: { name: { type: "string" }, tagline: { type: "string" }, positioning: { type: "string" }, visual_identity: { type: "string" } } },
    characters: { type: "array", items: { type: "object", additionalProperties: false, required: ["name_or_role", "design", "prominence"],
      properties: { name_or_role: { type: "string" }, design: { type: "string" }, prominence: { type: "string", enum: ["lead", "supporting", "background"] } } } },
  },
};

/** Own-content mode: the same summary in full detail, for making new versions of the producer's own video. */
async function describeOwnContent(video, shots, model) {
  const mp3 = hasAudio(video) ? run("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"], "buffer").stdout : null;
  const picks = shots.length <= 10 ? shots : Array.from({ length: 10 }, (_, i) => shots[Math.round((i * (shots.length - 1)) / 9)]);
  const frames = picks.map((s) => grab(video, (s.start + s.end) / 2, "scale=512:-2", "jpeg"));
  const text = `This is the producer's own video; they will make new versions of it. Describe it in full detail.
message_summary at most 80 words. offers_or_claims and call_to_action exactly as presented. brand: name, the tagline
exactly as shown or spoken (empty if none), positioning, and visual_identity (colours, logo and type style). characters:
every recurring character, with a design description of at most 70 words (proportions, face, hair, outfit, colours,
material or render style) precise enough to keep them consistent in new shots. The images are frames in order.`;
  const content = [{ type: "text", text }, ...frames.map((jpeg) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } })),
    ...(mp3 ? [{ type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } }] : [])];
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "own_content", strict: true, schema: OWN_CONTENT_SCHEMA } } });
  const raw = json.choices?.[0]?.message?.content ?? "";
  const c = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return { summary: { own: true, messageSummary: c.message_summary, offersOrClaims: c.offers_or_claims, callToAction: c.call_to_action,
    tone: c.tone, musicTheme: c.music_theme, brand: c.brand, characters: c.characters }, cost: json.usage?.cost ?? 0 };
}

async function summariseContent(video, shots, model) {
  const mp3 = hasAudio(video) ? run("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-"], "buffer").stdout : null;
  const picks = shots.length <= 8 ? shots : Array.from({ length: 8 }, (_, i) => shots[Math.round((i * (shots.length - 1)) / 7)]);
  const frames = picks.map((s) => grab(video, (s.start + s.end) / 2, "scale=384:-2", "jpeg"));
  const text = `Summarise this short video for a producer planning an original video of their own in the same genre.
Paraphrase everything in your own words. Never quote speech, lyrics or on-screen text word for word, and keep each
item short: message_summary at most 60 words, each offer or claim at most 12 words, call_to_action at most 12 words,
tone at most 5 words, brand positioning and visual identity at most 25 words each, music_theme at most 15 words.
Describe characters only at the level of role and archetype (at most 12 words each, no detailed design), so the
producer can make sure their own cast is clearly different. For on-screen text give its role and what it conveys,
not its wording. The images are frames from across the video, in order.`;
  const content = [{ type: "text", text }, ...frames.map((jpeg) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } })),
    ...(mp3 ? [{ type: "input_audio", input_audio: { data: mp3.toString("base64"), format: "mp3" } }] : [])];
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name: "content_summary", strict: true, schema: CONTENT_SCHEMA } } });
  const raw = json.choices?.[0]?.message?.content ?? "";
  const c = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const summary = {
    messageSummary: words(c.message_summary, 60), offersOrClaims: c.offers_or_claims.slice(0, 6).map((o) => words(o, 12)),
    callToAction: words(c.call_to_action, 12), tone: words(c.tone, 5), musicTheme: words(c.music_theme, 15),
    brand: { name: words(c.brand.name, 6), positioning: words(c.brand.positioning, 25), visualIdentity: words(c.brand.visual_identity, 25) },
    characters: c.characters.slice(0, 8).map((x) => ({ role: words(x.role, 6), archetype: words(x.archetype, 12), prominence: x.prominence })),
    onScreenText: c.on_screen_text.slice(0, 8).map((x) => ({ role: LABELS.text_role.includes(x.role) ? x.role : "label", purpose: words(x.purpose, 12) })),
  };
  return { summary, cost: json.usage?.cost ?? 0 };
}

// ---------- template ----------

const GRAMMAR = ["beat", "shot_size", "angle", "camera_move", "person_on_screen", "text_role", "text_position"];

/** The format rules a remake keeps, in plain sentences, from the measured and labelled reference. */
function holdConstant(summary, shots) {
  const rules = [];
  const fps = Math.round(summary.fps);
  rules.push(`Build the timeline at ${fps} fps (the reference runs at ${summary.fps}); slot startFrame and frames are in that rate, so generated 24 fps footage needs no frame repeats.`);
  if (shots.some((s) => s.people_count !== undefined)) {
    rules.push(`People in frame per slot: ${shots.filter((s) => s.people_count !== undefined).map((s) => `${s.index}:${s.people_count}${s.hands_in_frame ? "+hands" : ""}`).join(" ")}. Match each count exactly.`);
  }
  const characters = summary.continuity?.characters ?? {}, setups = summary.continuity?.setups ?? {};
  for (const [id, slots] of Object.entries(characters)) rules.push(`Recurring character ${id} appears in slots ${slots.join(", ")}: one of our characters fills that role in exactly those slots.`);
  for (const [id, slots] of Object.entries(setups)) rules.push(`Slots ${slots.join(", ")} repeat camera setup ${id}: shoot them in one location with the same camera position and framing.`);
  const media = [...new Set(shots.map((s) => s.medium).filter(Boolean))];
  if (media.length > 1) rules.push(`Medium changes by slot: ${media.map((m) => `${m} in ${shots.filter((s) => s.medium === m).map((s) => s.index).join(", ")}`).join("; ")}.`);
  const held = shots.filter((s) => s.device === "held-up").map((s) => s.index);
  if (held.length) rules.push(`A character holds up a phone or screen in slots ${held.join(", ")}.`);
  for (const s of shots.filter((x) => x.device === "screen-closeup" || x.beat === "cta" || x.subject === "graphic-card")) {
    if (s.layout_note) rules.push(`Slot ${s.index} layout (${s.device === "screen-closeup" ? "screen close-up" : s.beat === "cta" ? "end card" : "graphic card"}): ${s.layout_note}`);
  }
  const inWorld = shots.filter((s) => s.text_layer === "in-world" || s.text_layer === "both").map((s) => s.index);
  const overlay = shots.filter((s) => s.text_layer === "overlay" || s.text_layer === "both").map((s) => s.index);
  rules.push(`Text: overlays only in slots ${overlay.join(", ") || "none"}; text that is part of the scene (signs, screens) in ${inWorld.join(", ") || "none"}.`);
  const a = summary.audio;
  if (a?.voiceover) {
    const phrases = summary.voicePhrases ?? [];
    rules.push(`Voice: ${a.voice_delivery} ${a.voice_gender} ${a.voice_age} voice, ${a.voice_energy} energy, ${phrases.length} phrase(s), ${summary.speechPace?.words ?? "?"} words${a.music_ducks_under_voice ? "; music ducks under it" : ""}. Write our own line for every phrase with the same word count (plus or minus one) at the same times.`);
  } else if (a) {
    rules.push("No voiceover: music and effects only.");
  }
  const m = summary.metrics ?? {};
  if (m.tempoBpm) rules.push(`Music near ${Math.round(m.tempoBpm)} BPM with a beat by ${m.firstBeat}s; ${m.cutsOnHalfBeat} of ${m.cutsMeasured} cuts land on a beat or half-beat.`);
  return rules;
}

function writeTemplate(out, summary, shots) {
  const own = summary.ownContent === true;
  const fps = Math.round(summary.fps);
  const template = {
    format: "shot-list.template@2",
    note: own ? "Own content: prompts start from each shot's description; edit what this version changes. Source frames may be added to references."
      : "Structure only: slot timing, shot grammar and the format variables to hold constant. Write every prompt and voice line yourself, about your own subject; nothing here describes the source's content.",
    fps: summary.fps, timelineFps: fps, aspectRatio: summary.aspectRatio, duration: summary.duration,
    seedance: { model: "mini", resolution: "720p" },
    holdConstant: holdConstant(summary, shots),
    ...(summary.audio ? { voiceover: { present: summary.audio.voiceover, delivery: summary.audio.voice_delivery,
      voice: `${summary.audio.voice_gender}, ${summary.audio.voice_age}, ${summary.audio.voice_energy}`, musicDucks: summary.audio.music_ducks_under_voice,
      phrases: (summary.voicePhrases ?? []).map((p) => ({ ...p, line: own ? undefined : "" })) } } : {}),
    ...(summary.metrics?.tempoBpm ? { music: { tempoBpm: summary.metrics.tempoBpm, firstBeat: summary.metrics.firstBeat,
      cutsOnHalfBeat: `${summary.metrics.cutsOnHalfBeat}/${summary.metrics.cutsMeasured}` } } : {}),
    continuity: summary.continuity ?? {},
    slots: shots.map((s) => ({ slot: s.index, start: round(s.start), duration: round(s.duration),
      startFrame: Math.round(s.start * fps), frames: Math.round(s.end * fps) - Math.round(s.start * fps),
      ...Object.fromEntries([...GRAMMAR, ...HOLD, "characters", "setup", "layout_note", "motion", "vo_words"]
        .filter((k) => s[k] !== undefined && s[k] !== "").map((k) => [k, s[k]])),
      ...(own ? { sourceFrame: s.frame, ...(s.on_screen_text ? { onScreenText: s.on_screen_text } : {}) } : {}),
      prompt: own && s.description ? s.description : "" })),
  };
  writeFileSync(join(out, "template.json"), `${JSON.stringify(template, null, 2)}\n`);
  const cell = (s, k) => (s[k] === undefined ? "" : Array.isArray(s[k]) ? s[k].join(" ") : String(s[k]));
  writeFileSync(join(out, "template.md"), [
    `# Format template (${summary.shots} slots, ${summary.duration}s, ${summary.aspectRatio}, ${fps} fps)`, "",
    "Structure only. Fill each slot's `prompt` (and each voice phrase's `line`) in template.json with your own subject,",
    "then run `node tools/shot-list.mjs --svml template.json` to write a Hypit project that generates new shots.", "",
    "## Hold constant", ...template.holdConstant.map((r) => `- ${r}`), "",
    "## Slots",
    "| Slot | Frames | Beat | Size | Angle | Move | People | Cast | Setup | Medium | Device / prop | Text | VO words |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...template.slots.map((s) => `| ${s.slot} | ${s.startFrame}+${s.frames} | ${cell(s, "beat")} | ${cell(s, "shot_size")} | ${cell(s, "angle")} | ${cell(s, "camera_move")} | ${cell(s, "people_count")}${s.hands_in_frame ? " +hands" : ""} | ${cell(s, "characters")} | ${cell(s, "setup")} | ${cell(s, "medium")} | ${[s.device, s.held_prop].filter((x) => x && x !== "none").join(", ")} | ${s.text_layer && s.text_layer !== "none" ? `${s.text_layer}${s.text_role && s.text_role !== "none" ? ` ${s.text_role} (${s.text_position})` : ""}` : ""} | ${cell(s, "vo_words")} |`),
    ...(template.voiceover?.phrases?.length ? ["", "## Voice phrases (write our own line for each)", "| Phrase | Time | Words | Slots |", "|---|---|---|---|",
      ...template.voiceover.phrases.map((p) => `| ${p.phrase} | ${p.start.toFixed(2)}s to ${p.end.toFixed(2)}s | ${p.words} | ${p.slots.join(", ")} |`)] : []),
    "",
  ].join("\n"));
}

function writeSpec(out, summary, shots) {
  const m = summary.metrics ?? {}, a = summary.audio, pace = summary.speechPace;
  const v = (value, unit = "") => (value === undefined || value === null ? "not measured" : `${value}${unit}`);
  const cell = (s, k) => (s[k] === undefined ? "" : String(s[k]));
  const within = (value, share) => `${round(value * (1 - share))} to ${round(value * (1 + share))}`;
  const lines = [
    `# Video spec: ${summary.video}`, "",
    "Single source of truth for the remake. Parts 1 to 4 are measured from the reference and copied exactly; parts 5 to 7",
    "are ours and describe none of the reference's content. The builder works from this file and never from the reference.", "",
    "## 1. Overview",
    `- Reference: ${summary.video} (${summary.duration}s, ${summary.resolution}, ${summary.fps} fps, ${summary.aspectRatio})`,
    "- Our video's purpose: TODO (one line)",
    "- Budget cap (USD): TODO. Run `hypit pricing` before every paid step and stop if the quote exceeds it.", "",
    "## 2. Format tokens (measured)",
    "| Token | Value |", "|---|---|",
    `| Duration | ${summary.duration}s |`, `| Frame | ${summary.resolution}, ${summary.aspectRatio}, ${summary.fps} fps |`,
    `| Shots | ${summary.shots} |`, `| Average shot | ${summary.averageShot}s |`, `| Shortest / longest shot | ${summary.shortestShot}s / ${summary.longestShot}s |`,
    `| First cut | ${v(summary.firstCut, "s")} |`, `| Cuts per second | ${v(m.cutsPerSecond)} |`,
    `| Shots starting per 5 s | ${m.shotsPerFiveSeconds ? m.shotsPerFiveSeconds.join(", ") : "not measured"} |`,
    `| Motion (median / p90 frame difference) | ${v(m.motionMedian)} / ${v(m.motionP90)} |`,
    `| Brightness / saturation / contrast | ${v(m.brightness)} / ${v(m.saturation)} / ${v(m.contrast)} |`,
    `| Loudness / true peak / range | ${v(m.loudnessLufs, " LUFS")} / ${v(m.truePeakDb, " dBTP")} / ${v(m.loudnessRangeLu, " LU")} |`,
    `| Music tempo / cuts on a beat or half-beat | ${v(m.tempoBpm, " BPM")} / ${m.cutsMeasured ? `${m.cutsOnHalfBeat} of ${m.cutsMeasured}` : "not measured"} |`,
    `| Repeated frames (judder) | ${v(m.repeatedFrames)} |`,
    ...(summary.personOnScreenShare !== undefined ? [`| Shots with a person / with on-screen text | ${Math.round(summary.personOnScreenShare * 100)}% / ${Math.round(summary.textOverlayShare * 100)}% |`] : []),
    "",
    "## 3. Beat map (measured)",
    "| Slot | Start | Length | Beat | Size | Angle | Move | Subject type | People | Cast | Setup | Medium | Device / prop | Text (layer, role, position) | VO words |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...shots.map((s) => `| ${s.index} | ${s.start.toFixed(2)}s | ${s.duration.toFixed(2)}s | ${cell(s, "beat")} | ${cell(s, "shot_size")} | ${cell(s, "angle")} | ${cell(s, "camera_move")} | ${cell(s, "subject")} | ${cell(s, "people_count")}${s.hands_in_frame ? " +hands" : ""} | ${[s.characters ?? []].flat().join(" ")} | ${cell(s, "setup")} | ${cell(s, "medium")} | ${[s.device, s.held_prop].filter((x) => x && x !== "none").join(", ")} | ${s.text_layer && s.text_layer !== "none" ? [s.text_layer, s.text_role !== "none" && s.text_role, s.text_role !== "none" && s.text_position].filter(Boolean).join(", ") : ""} | ${cell(s, "vo_words")} |`),
    "",
    "## 3b. Hold constant (our version matches every line)",
    ...holdConstant(summary, shots).map((r) => `- ${r}`),
    "",
    "## 4. Audio structure (measured)",
    ...(a ? [`- Voiceover: ${a.voiceover ? `yes, ${a.voice_delivery} (${a.voice_gender}, ${a.voice_age}, ${a.voice_energy})${a.music_ducks_under_voice ? ", music ducks under it" : ""}` : "no"}`,
      `- Speech pace: ${pace ? `${pace.words} words over ${round(pace.speechEnd - pace.speechStart)}s, ${pace.wordsPerSecond} words/s, ${pace.pausesOver300ms} pauses over 0.3s, longest ${pace.longestPause}s` : "no speech"}`,
      ...(summary.voicePhrases?.length ? ["- Voice phrases (timing and word count only):", ...summary.voicePhrases.map((p) => `  - ${p.phrase}: ${p.start.toFixed(2)}s to ${p.end.toFixed(2)}s, ${p.words} words, over slots ${p.slots.join(", ")}`)] : []),
      `- Music: ${a.music ? `${a.music_genre}, ${a.music_mood}, about ${a.bpm_estimate} BPM by ear${m.tempoBpm ? ` (${m.tempoBpm} measured)` : ""}, ${a.music_vocals ? "with" : "no"} vocals` : "none"}`,
      `- Sound effects: ${a.sfx ? "yes" : "no"} · Ending: ${a.ending}`] : ["- Not analysed (run with --analyze)."]),
    "",
    ...(summary.ownContent ? ownSpecSections(summary, shots) : [
    "## 4b. What the reference says and shows (paraphrased; for understanding and contrast, never reuse)",
    ...(summary.content ? (() => { const c = summary.content; return [
      `- Message: ${c.messageSummary}`, `- Offers or claims: ${c.offersOrClaims.length ? c.offersOrClaims.join("; ") : "none"}`,
      `- Call to action: ${c.callToAction} · Tone: ${c.tone}`, `- Music theme: ${c.musicTheme}`,
      `- Brand: ${c.brand.name}. Positioning: ${c.brand.positioning}. Visual identity: ${c.brand.visualIdentity}`,
      "- Cast (archetypes only; ours must be clearly different):", ...c.characters.map((x) => `  - ${x.role} (${x.prominence}): ${x.archetype}`),
      "- On-screen text (purpose, not wording):", ...c.onScreenText.map((x) => `  - ${x.role}: ${x.purpose}`)]; })() : ["- Not analysed (run with --analyze)."]),
    ""]),
    ...(summary.ownContent ? ["## 5. This version: what stays and what changes",
      "- Keep: (characters, brand, voice, music, shots that stay as they are)",
      "- Change: (offer, product, length, aspect, script lines, shots to replace)",
      "- Slot prompts: template.json starts from each shot's description; edit only what this version changes", ""] : [
    "## 5. Our creative layer (write before building; describe nothing from the reference)",
    "- Brand: name, palette (hex), logo or wordmark, end-card copy",
    "- Characters: each one designed from scratch (shape, outfit, colours, style) and how it differs from anyone in the reference",
    "- Setting(s):",
    "- Script / voiceover lines (our words), with target words per second from part 4:",
    "- Music brief (generated fresh; genre, tempo and energy may follow part 4):",
    "- Text system: title, caption and deal/label styles (font, size, colours, positions) for the roles in part 3",
    "- Slot prompts: fill `prompt` for every slot in template.json; keep each slot's timing and grammar from part 3", ""]),
    "## 6. Production plan",
    "| Step | Model / tool | Seconds or count | Quote (USD) |", "|---|---|---|---|",
    "| Reference images (characters, sets) | GPT Image 2, 1K | TODO | TODO |",
    "| Video | Seedance (variant), grouped with --svml --group | TODO | TODO |",
    "| Music / voice | Lyria 3 / ElevenLabs preset voice via OpenRouter | TODO | TODO |",
    "| Render | Hypit on the server | - | 0 |", "",
    ...(summary.ownContent ? ["## 7. Rights checklist (all must hold)",
      "- [ ] We made this video or hold the rights to adapt it",
      "- [ ] Licensed parts (stock footage, music, fonts) allow new versions",
      "- [ ] Every real person shown or voiced has consented to new versions", ""] : [
    "## 7. Originality checklist (all must hold)",
    "- [ ] No reference frame, clip or audio is used as a generation input or appears in the output",
    "- [ ] No transcribed speech, lyrics or on-screen copy from the reference",
    "- [ ] Characters, brand, logo, slogan and music are our own designs",
    "- [ ] Real brands, people and trademarks appear only if we own or are licensed to use them", ""]),
    "## 8. Verification targets",
    "Run `node tools/shot-list.mjs <render> --compare <this folder>/shots.json --out <dir>`; DELTA.md lists every miss.",
    `- Duration ${summary.duration}s (within one frame) · every cut on its slot boundary (within one frame)`,
    `- Shots ${within(summary.shots, 0.15)} · average shot ${within(summary.averageShot, 0.2)}s · first cut within 0.5s of ${v(summary.firstCut, "s")}`,
    ...(m.loudnessLufs !== undefined ? [`- Loudness ${round(m.loudnessLufs - 1)} to ${round(m.loudnessLufs + 1)} LUFS, true peak at or below -1 dBTP`] : []),
    "- Every line of 3b holds; repeated frames 0",
    "",
  ];
  writeFileSync(join(out, "VIDEO_SPEC.md"), lines.join("\n"));
}

/** Own content: full description, transcript and per-shot copy, for faithful new versions. */
function ownSpecSections(summary, shots) {
  const c = summary.content;
  const out = ["## 4b. Content (own video, full detail)"];
  if (c) {
    out.push(`- Message: ${c.messageSummary}`, `- Offers or claims: ${c.offersOrClaims.length ? c.offersOrClaims.join("; ") : "none"}`,
      `- Call to action: ${c.callToAction} · Tone: ${c.tone}`, `- Music theme: ${c.musicTheme}`,
      `- Brand: ${c.brand.name}${c.brand.tagline ? ` · Tagline: "${c.brand.tagline}"` : ""}`, `  - Positioning: ${c.brand.positioning}`, `  - Visual identity: ${c.brand.visualIdentity ?? c.brand.visual_identity}`,
      "- Characters:", ...c.characters.map((x) => `  - ${x.name_or_role} (${x.prominence}): ${x.design}`));
  } else {
    out.push("- Not analysed (run with --analyze --own).");
  }
  out.push("", "## 4c. Transcript (own video)");
  out.push(...(summary.transcriptLines?.length ? summary.transcriptLines.map((l) => `- ${l.start.toFixed(2)}s to ${l.end.toFixed(2)}s: ${l.text}`)
    : ["- No transcript (no speech, or not analysed with --analyze --own). Full word timings: transcript.json."]));
  out.push("", "## 4d. Shot descriptions and on-screen text (own video)", "| Slot | Description | On-screen text |", "|---|---|---|",
    ...shots.map((s) => `| ${s.index} | ${String(s.description ?? "").replace(/\|/g, "/")} | ${String(s.on_screen_text ?? "").replace(/\|/g, "/")} |`), "");
  return out;
}

// ---------- compare ----------

/**
 * DELTA.md: our render measured on the reference's slots, every format variable checked against the reference
 * analysis (shots.json from the same tool version). Lists each miss, then the slot-by-slot table.
 */
function writeDelta(out, reference, summary, record, cuts, info) {
  const ref = reference.summary, theirs = reference.shots, misses = [];
  let total = 0;
  const check = (scope, field, a, b, pass) => { total++; if (!pass) misses.push({ scope, field, reference: a, ours: b }); };
  const show = (v) => (v === undefined || v === null ? "-" : Array.isArray(v) ? v.join(" ") || "-" : String(v));
  const near = (a, b, share) => a !== undefined && b !== undefined && Math.abs(a - b) <= Math.abs(a) * share;
  const frame = 1 / Math.min(info.fps, ref.fps);

  // Picture timing and cadence.
  check("video", "duration", `${ref.duration}s`, `${summary.duration}s`, Math.abs(ref.duration - summary.duration) <= frame + 0.001);
  check("video", "frame rate", ref.fps, summary.fps, Math.round(ref.fps) === Math.round(summary.fps));
  const rm = ref.metrics ?? {}, om = summary.metrics ?? {};
  check("video", "repeated frames (judder)", rm.repeatedFrames, om.repeatedFrames, om.repeatedFrames <= Math.max(2, rm.repeatedFrames ?? 0));
  for (const r of theirs.slice(1)) {
    const hit = cuts.soft.some((c) => Math.abs(c - r.start) <= 1.5 * frame);
    check(`slot ${r.shot}`, "hard cut at slot start", `${r.start}s`, hit ? `${r.start}s` : "none detected", hit);
  }
  for (const c of cuts.hard) {
    const inside = theirs.find((r) => c > r.start + 2 * frame && c < r.end - 2 * frame);
    if (inside) check(`slot ${inside.shot}`, "no cut inside the slot", "none", `cut at ${round(c)}s`, false);
  }
  // Look and sound.
  check("video", "brightness", rm.brightness, om.brightness, near(rm.brightness, om.brightness, 0.1));
  check("video", "saturation", rm.saturation, om.saturation, near(rm.saturation, om.saturation, 0.2));
  check("audio", "loudness (LUFS)", rm.loudnessLufs, om.loudnessLufs, Math.abs((rm.loudnessLufs ?? 0) - (om.loudnessLufs ?? 0)) <= 1);
  check("audio", "music tempo (BPM)", rm.tempoBpm, om.tempoBpm, near(rm.tempoBpm, om.tempoBpm, 0.04));
  check("audio", "cuts on a beat or half-beat", rm.cutsOnHalfBeat, om.cutsOnHalfBeat, (om.cutsOnHalfBeat ?? 0) >= (rm.cutsOnHalfBeat ?? 0) - 2);
  const ra = ref.audio ?? {}, oa = summary.audio ?? {};
  check("audio", "voiceover", ra.voiceover, oa.voiceover, ra.voiceover === oa.voiceover);
  if (ra.voiceover) {
    check("audio", "voice delivery", ra.voice_delivery, oa.voice_delivery, ra.voice_delivery === oa.voice_delivery);
    check("audio", "voice type", `${ra.voice_gender}, ${ra.voice_age}`, `${oa.voice_gender}, ${oa.voice_age}`, ra.voice_gender === oa.voice_gender && ra.voice_age === oa.voice_age);
    check("audio", "voice phrases", ref.voicePhrases?.length ?? 0, summary.voicePhrases?.length ?? 0, Math.abs((ref.voicePhrases?.length ?? 0) - (summary.voicePhrases?.length ?? 0)) <= 1);
    check("audio", "voice words", ref.speechPace?.words ?? 0, summary.speechPace?.words ?? 0, near(ref.speechPace?.words ?? 0, summary.speechPace?.words ?? 0, 0.2));
  }
  // Slot by slot.
  const ours = new Map(record.map((r) => [r.shot, r]));
  for (const r of theirs) {
    const o = ours.get(r.shot);
    if (!o) { check(`slot ${r.shot}`, "present", "yes", "missing", false); continue; }
    const same = (field, a, b) => a === b || (field === "medium" && ["3d-animation", "stop-motion"].includes(a) && ["3d-animation", "stop-motion"].includes(b));
    for (const field of [...HOLD, "shot_size", "angle", "camera_move"]) {
      if (r[field] !== undefined) check(`slot ${r.shot}`, field, r[field], o[field], same(field, r[field], o[field]));
    }
    if (r.motion !== undefined && o.motion !== undefined && Math.max(r.motion, o.motion) >= 0.5) {
      check(`slot ${r.shot}`, "motion", r.motion, o.motion, o.motion >= r.motion / 2 && o.motion <= r.motion * 2);
    }
    if (r.vo_words !== undefined) check(`slot ${r.shot}`, "voice words", r.vo_words, o.vo_words ?? 0, Math.abs(r.vo_words - (o.vo_words ?? 0)) <= Math.max(1, r.vo_words * 0.25));
  }
  // Callbacks: slots that share a setup or a recurring character in the reference should share one in ours.
  const groupOf = (rows, key, slots) => slots.map((n) => [rows.find((x) => x.shot === n)?.[key]].flat().filter((v) => v && v !== "hands"));
  for (const [id, slots] of Object.entries(ref.continuity?.setups ?? {})) {
    const got = groupOf(record, "setup", slots).map((v) => v[0]);
    check(`slots ${slots.join(",")}`, `repeat one camera setup (${id})`, `${id} in all`, got.map(show).join(" / "), got.every((v) => v && v === got[0]));
  }
  for (const [id, slots] of Object.entries(ref.continuity?.characters ?? {})) {
    const sets = groupOf(record, "characters", slots);
    const shared = sets.reduce((acc, v) => acc.filter((x) => v.includes(x)), sets[0] ?? []);
    check(`slots ${slots.join(",")}`, `one recurring character (${id})`, `${id} in all`, sets.map((v) => v.join("+") || "-").join(" / "), shared.length > 0);
  }

  const passed = total - misses.length;
  const lines = [
    `# Delta: ${summary.video} against ${ref.video}`, "",
    `${passed} of ${total} format checks match. Each miss below is a variable the template holds constant.`, "",
    "## Misses", "| Where | Variable | Reference | Ours |", "|---|---|---|---|",
    ...misses.map((m) => `| ${m.scope} | ${m.field} | ${show(m.reference)} | ${show(m.ours)} |`), "",
    "## Slot by slot (reference / ours)",
    "| Slot | People | Medium | Device / prop | Setting | Text | Size | Motion | VO words | Setup | Cast |", "|---|---|---|---|---|---|---|---|---|---|---|",
    ...theirs.map((r) => {
      const o = ours.get(r.shot) ?? {};
      const pair = (k) => `${show(r[k])} / ${show(o[k])}`;
      const dp = (x) => [x.device, x.held_prop].filter((v) => v && v !== "none").join(", ") || "-";
      return `| ${r.shot} | ${show(r.people_count)}${r.hands_in_frame ? "+h" : ""} / ${show(o.people_count)}${o.hands_in_frame ? "+h" : ""} | ${pair("medium")} | ${dp(r)} / ${dp(o)} | ${pair("setting")} | ${pair("text_layer")} | ${pair("shot_size")} | ${pair("motion")} | ${pair("vo_words")} | ${pair("setup")} | ${pair("characters")} |`;
    }), "",
  ];
  writeFileSync(join(out, "DELTA.md"), lines.join("\n"));
  writeFileSync(join(out, "delta.json"), `${JSON.stringify({ reference: ref.video, ours: summary.video, total, passed, misses }, null, 2)}\n`);
  console.log(`Delta: ${passed} of ${total} format checks match; ${misses.length} miss(es) in DELTA.md`);
}

/** Text safe inside an SVML text:Value body. */
function svmlText(text) {
  return String(text).replace(/[{}]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
}

function writeSvml(templatePath, outOption, groupSeconds) {
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  if (!["shot-list.template@1", "shot-list.template@2"].includes(template.format)) throw new Error(`${templatePath} is not a shot-list template`);
  const empty = template.slots.filter((s) => !String(s.prompt ?? "").trim()).map((s) => s.slot);
  if (empty.length) throw new Error(`fill the prompt of slot${empty.length > 1 ? "s" : ""} ${empty.join(", ")} first`);
  const long = template.slots.filter((s) => s.duration > 15).map((s) => s.slot);
  if (long.length) throw new Error(`slot${long.length > 1 ? "s" : ""} ${long.join(", ")} run longer than Seedance's 15s; split them`);
  const fps = template.timelineFps ?? Math.round(template.fps ?? 30);
  const [rw, rh] = String(template.aspectRatio ?? "9:16").split(":").map(Number);
  const portrait = rh >= rw;
  const ratio = portrait ? "9:16" : "16:9";
  const canvas = portrait ? [1080, 1920] : [1920, 1080];
  const variant = template.seedance?.model ?? "mini";
  const resolution = template.seedance?.resolution ?? "720p";
  const references = template.references ?? [];
  for (const r of references) if (typeof r.path !== "string" || typeof r.personReference !== "boolean") throw new Error("each reference needs a path and a personReference boolean");
  const pad = (n) => String(n).padStart(2, "0");
  const punctuate = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);
  const MEDIUM = { "live-action": "Photoreal live-action footage", "stop-motion": "Stop-motion animation", "3d-animation": "3D animation",
    "2d-animation": "2D animation", "motion-graphics": "Motion graphics", mixed: "" };
  // template@2 hold-constant fields become plain instructions in each shot line.
  const holdLine = (s) => {
    const parts = [];
    if (Number.isInteger(s.people_count)) {
      parts.push(s.people_count === 0 ? (s.hands_in_frame ? "Only hands in frame, no faces" : "No people in frame")
        : `Exactly ${s.people_count} ${s.people_count === 1 ? "character" : "characters"} in frame${s.hands_in_frame ? ", plus hands" : ""}`);
    }
    if (s.device === "held-up") parts.push("a character holds up a phone with its screen facing camera");
    if (s.device === "screen-closeup") parts.push("close-up of a phone held in hand; its screen is blank, plain light grey, for a graphic to be laid over it");
    return parts.length ? `${parts.join("; ")}.` : "";
  };

  // Neighbouring slots share one multi-shot clip up to groupSeconds (0 keeps one clip per slot), never across a change of medium.
  const groups = [];
  for (const slot of template.slots) {
    const last = groups.at(-1);
    if (last && groupSeconds > 0 && last.seconds + slot.duration <= groupSeconds && last.slots.at(-1).medium === slot.medium) { last.slots.push(slot); last.seconds += slot.duration; }
    else groups.push({ slots: [slot], seconds: slot.duration });
  }
  let frame = 0, billed = 0;
  const clips = groups.map((g, i) => {
    const from = frame;
    let offset = 0;
    const shotLines = g.slots.map((s, k) => {
      const camera = [s.shot_size && `${s.shot_size} shot`, s.angle && `${s.angle} angle`, s.camera_move && s.camera_move !== "unclear" && `${s.camera_move} camera`].filter(Boolean).join(", ");
      const hold = holdLine(s);
      const text = `${g.slots.length > 1 ? `Shot ${k + 1}, ${round(offset)} to ${round(offset + s.duration)} seconds: ` : ""}${punctuate(svmlText(s.prompt))}${hold ? ` ${hold}` : ""}${camera ? ` Camera: ${camera}.` : ""}`;
      offset += s.duration;
      frame += s.frames ?? Math.max(1, Math.round(s.duration * fps));
      return text;
    });
    const clip = Math.min(15, Math.max(4, Math.ceil(g.seconds)));
    billed += clip;
    const medium = g.slots[0].medium;
    const style = template.styleByMedium?.[medium] ?? template.style ?? MEDIUM[medium] ?? "";
    const repeats = g.slots.filter((s) => s.setup && template.slots.some((o) => o.setup === s.setup && o.slot < s.slot)).map((s) =>
      `slot ${s.slot} repeats setup ${s.setup} from slot ${template.slots.find((o) => o.setup === s.setup).slot}`);
    return { id: `clip-${pad(i + 1)}`, from, until: frame, clip, slots: g.slots.map((s) => s.slot), shotLines, style, repeats };
  });

  const modules = [["text", "@hypit/text@1"], ...(references.length ? [["asset", "@hypit/media@1"]] : []), ["seedance", "@hypit/seedance@1"],
    ["mediaop", "@hypit/media-operations@1"], ["time", "@hypit/timeline-author@1"], ["space", "@hypit/spatial@1"], ["visual", "@hypit/visual-track@1"],
    ["film", "@hypit/film@1"], ["html", "@hypit/html-video@1"]];
  const lines = [
    '<?svml using="@hypit/markup@1"?>', "<svml>", ...modules.map(([as, from]) => `  <import as="${as}" from="${from}"/>`),
    '  <import as="look" source="./look.svs"/>', "",
    `  <!-- Generated by tools/shot-list.mjs from ${basename(templatePath)}: ${clips.length} new Seedance clip(s), each cut to its slots' length. -->`,
    `  <space:Canvas id="canvas" width="${canvas[0]}" height="${canvas[1]}"/>`, `  <time:Clock id="clock" frame-rate="${fps}"/>`,
    '  <space:Frame id="full" within={canvas.bounds} left="0%" top="0%" right="100%" bottom="100%"/>',
    ...references.map((r, i) => `  <asset:Image id="ref-${i + 1}" src="${svmlText(r.path)}"/>`),
  ];
  const referenceLine = references.length ? `${references.map((r, i) => `@image${i + 1} ${svmlText(r.role ?? "is a reference")}`).join("; ")}. Keep their designs.` : "";
  for (const c of clips) {
    const style = c.style ? svmlText(c.style) : "";
    lines.push("", `  <!-- Slots ${c.slots.join(", ")}${c.repeats.length ? `; ${c.repeats.join("; ")}: use the same set reference` : ""} -->`, `  <text:Value id="${c.id}-prompt">`,
      ...[style && punctuate(style), referenceLine, ...c.shotLines].filter(Boolean).map((l) => `    ${l}`),
      "    No on-screen text, no letters on signs, no logos.", "  </text:Value>");
    const attrs = `model="${variant}" prompt={${c.id}-prompt} duration="${c.clip}"\n    resolution="${resolution}" aspect-ratio="${ratio}" generate-audio="false"`;
    if (references.length) {
      lines.push(`  <seedance:ReferenceVideo id="${c.id}" ${attrs}>`,
        ...references.map((r, i) => `    <seedance:Reference image={ref-${i + 1}} person-reference="${r.personReference}"/>`), "  </seedance:ReferenceVideo>");
    } else {
      lines.push(`  <seedance:TextVideo id="${c.id}" ${attrs}/>`);
    }
    lines.push(`  <mediaop:Normalize id="${c.id}-media" source={${c.id}.video} clock={clock} video="primary-moving" audio="none" span-authority="video"/>`);
  }
  lines.push("", `  <time:Timeline id="story" clock={clock} end="${frame}f">`,
    ...clips.map((c) => `    <time:Window id="${c.id}" from="${c.from}f" until="${c.until}f"/>`), "  </time:Timeline>",
    '  <visual:Track id="picture" timeline={story.timeline}>',
    ...clips.map((c) => `    <visual:Clip id="${c.id}-clip" media={${c.id}-media.media} during={story.${c.id}} frame={full} z="0" fit="cover"/>`),
    "  </visual:Track>",
    '  <film:Film id="main" canvas={canvas.canvas} timeline={story.timeline} appearance={look.film.main}>', "    <film:Track source={picture.visual}/>", "  </film:Film>",
    '  <html:Video id="final" composition={main.composition} timeline={story.timeline}/>', "</svml>", "");
  const out = resolve(outOption ?? ".");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "main.svml"), lines.join("\n"));
  writeFileSync(join(out, "look.svs"), '<?svml using="@hypit/recipe@1"?>\n<sheet version="1">\n  film.main { background: #000000; }\n</sheet>\n');
  writeFileSync(join(out, "main.svrun"), '<?svml using="@hypit/markup/run@1"?>\n<svrun version="1">\n  <author source="./main.svml"/>\n  <target output="final.video"/>\n</svrun>\n');
  console.log(`Wrote ${out}/main.svml, main.svrun and look.svs: ${template.slots.length} slots in ${clips.length} clip(s), ${round(frame / fps)}s at ${fps} fps.`);
  console.log(`Seedance ${variant} ${resolution} will bill about ${billed}s of video (4s minimum per clip). Check with: hypit pricing main.svrun`);
}

// ---------- main ----------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.own) console.log("Own-content mode: transcripts, exact on-screen text and full designs. Use it only on video you own or are licensed to adapt.");
  if (options.svml !== undefined) return writeSvml(resolve(options.svml), options.out, options.group);
  const video = resolve(options.video);
  const out = resolve(options.out ?? `${basename(video, extname(video))}-shots`);
  const framesDir = join(out, "frames");
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });

  const info = probe(video);
  const reference = options.compare !== undefined ? JSON.parse(readFileSync(resolve(options.compare), "utf8")) : null;
  // --compare measures our render on the reference's own slots so every field lines up slot by slot; cuts are
  // checked separately: soft detection (0.1) for the boundaries, the normal threshold for stray cuts inside a slot.
  const cuts = reference ? { hard: detectCuts(video, options.threshold), soft: detectCuts(video, 0.1) } : null;
  const shots = reference
    ? reference.shots.map((r) => ({ index: r.shot, start: Math.min(r.start, info.duration), end: Math.min(r.end, info.duration) })).filter((s) => s.end > s.start)
    : buildShots(detectCuts(video, options.threshold), info.duration, options.minShot);
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
    for (const model of [options.model, options.fallbackModel]) {
      try {
        analysis.cost += (await continuity(video, shots, model)).cost;
        delete analysis.continuityError;
        break;
      } catch (error) {
        analysis.continuityError = error.message;
        console.error(`  continuity (${model}): ${error.message}`);
      }
    }
    try {
      analysis.content = options.own ? await describeOwnContent(video, shots, options.model) : await summariseContent(video, shots, options.model);
      analysis.cost += analysis.content.cost;
    } catch (error) {
      analysis.contentError = error.message;
      console.error(`  content summary: ${error.message}`);
    }
    if (hasAudio(video)) {
      try {
        analysis.audio = await analyseAudio(video, options.model, options.own);
        analysis.cost += analysis.audio.cost;
        if (analysis.audio.wordTimes?.length) {
          voicePerShot(analysis.audio.wordTimes, shots);
          analysis.voicePhrases = voicePhrases(analysis.audio.wordTimes, shots);
        } else {
          for (const s of shots) { s.vo_words = 0; s.vo_seconds = 0; }
        }
      } catch (error) {
        analysis.audioError = error.message;
        console.error(`  audio: ${error.message}`);
      }
    }
  }
  const metrics = options.metrics ? measureMetrics(video, shots, info) : undefined;

  const record = shots.map((s) => ({
    shot: s.index, start: round(s.start), end: round(s.end), duration: round(s.duration),
    startTimecode: timecode(s.start, info.fps), endTimecode: timecode(s.end, info.fps), frameAt: round(s.frameAt), frame: s.frame,
    ...(options.analyze ? Object.fromEntries([...Object.keys(SCHEMA.properties), "characters", "setup", "vo_words", "vo_seconds", "description", "on_screen_text", "motion", "palette", "analysisError"]
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
      shotSizes: tally(shots, "shot_size"), cameraMoves: tally(shots, "camera_move"), subjects: tally(shots, "subject"), media: tally(shots, "medium"),
      continuity: { characters: recurrence(shots, "characters"), setups: recurrence(shots, "setup") },
      ...(analysis.continuityError ? { continuityError: analysis.continuityError } : {}),
      ...(analysis.audio ? { audio: analysis.audio.labels, speechPace: analysis.audio.pace, voicePhrases: analysis.voicePhrases ?? [] } : {}),
      ...(analysis.audioError ? { audioError: analysis.audioError } : {}),
      ...(analysis.content ? { content: analysis.content.summary } : {}),
      ...(analysis.contentError ? { contentError: analysis.contentError } : {}),
    });
  }
  if (metrics) summary.metrics = metrics;
  if (options.own) summary.ownContent = true;
  const transcript = analysis?.audio?.transcript;
  if (transcript?.length) {
    const lines = transcriptLines(transcript);
    summary.transcriptLines = lines;
    writeFileSync(join(out, "transcript.json"), `${JSON.stringify({ words: transcript, lines }, null, 2)}\n`);
    writeFileSync(join(out, "transcript.srt"), lines.map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text}\n`).join("\n"));
  }

  writeFileSync(join(out, "shots.json"), `${JSON.stringify({ summary, shots: record }, null, 2)}\n`);
  const extra = options.analyze ? ["beat", "shot_size", "angle", "camera_move", "subject", "person_on_screen", "lighting", "text_role", "text_position",
    ...HOLD, "characters", "setup", "vo_words", "motion", "palette"] : [];
  const csvCell = (v) => (Array.isArray(v) ? v.join(" ") : v ?? "");
  writeFileSync(join(out, "shots.csv"), [["shot", "start", "end", "duration", "start_timecode", "end_timecode", "frame", ...extra].join(","),
    ...record.map((r) => [r.shot, r.start, r.end, r.duration, r.startTimecode, r.endTimecode, r.frame, ...extra.map((k) => csvCell(r[k]))].join(","))].join("\n") + "\n");

  const labelsHtml = (r) => !options.analyze ? "" : r.analysisError ? "<br><span>not labelled</span>"
    : `<br><span>${escapeHtml([r.beat, r.shot_size, r.angle, r.camera_move].join(" · "))}<br>${escapeHtml(r.subject)} · ${r.people_count} people${r.hands_in_frame ? " + hands" : ""} · ${escapeHtml(r.medium)}${r.setup ? ` · ${escapeHtml(r.setup)}` : ""}` +
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
  if (options.spec) writeSpec(out, summary, shots);
  if (reference) writeDelta(out, reference, summary, record, cuts, info);

  console.log(`${summary.shots} shots in ${summary.duration}s (average ${summary.averageShot}s, shortest ${summary.shortestShot}s, longest ${summary.longestShot}s)`);
  for (const r of record) {
    const labels = options.analyze && !r.analysisError ? `  ${r.beat} · ${r.shot_size} · ${r.angle} · ${r.camera_move} · ${r.subject}` : "";
    console.log(`  #${String(r.shot).padStart(3)}  ${r.startTimecode} → ${r.endTimecode}  ${r.duration.toFixed(2)}s  ${r.frame}${labels}`);
  }
  if (metrics) {
    console.log(`Metrics: ${metrics.loudnessLufs ?? "no audio"} LUFS, true peak ${metrics.truePeakDb ?? "-"} dBTP, brightness ${metrics.brightness}, ` +
      `saturation ${metrics.saturation}, contrast ${metrics.contrast}, motion ${metrics.motionMedian} (p90 ${metrics.motionP90}), ${metrics.cutsPerSecond} cuts/s`);
  }
  if (summary.audio) console.log(`Audio: ${JSON.stringify(summary.audio)}${summary.speechPace ? ` · ${summary.speechPace.wordsPerSecond} words/s` : ""}`);
  if (analysis) console.log(`Labelled ${shots.length - analysis.failures}/${shots.length} shots${analysis.audio ? " and the audio" : ""} for $${analysis.cost.toFixed(4)}.`);
  const written = ["shots.json", "shots.csv", "frames/", "contact-sheet.jpg", "index.html", ...(transcript?.length ? ["transcript.json", "transcript.srt"] : []),
    ...(options.template ? ["template.json", "template.md"] : []), ...(options.spec ? ["VIDEO_SPEC.md"] : []), ...(reference ? ["DELTA.md", "delta.json"] : [])];
  console.log(`Wrote ${out}/ (${written.join(", ")})`);
  if (analysis?.failures || analysis?.audioError || analysis?.contentError || analysis?.continuityError) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`shot-list: ${error.message}`);
  process.exit(1);
});
