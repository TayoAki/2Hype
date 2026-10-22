#!/usr/bin/env node
// Safe Hypit builds in two stages: paid generation first, then a free edit that reuses it.
// Needs ffprobe on PATH; `final` also uses `hypit` when it is on PATH; `recover` needs OPENROUTER_API_KEY.
//
//   node tools/hypit-stage.mjs lint main.svml
//       Resolves every Timeline Window to frames (local media lengths via ffprobe, generated clips from their
//       duration attribute) and fails when a Window runs past its Timeline's end, is empty, or plays a clip
//       shorter than itself. Run it before every Build.
//   node tools/hypit-stage.mjs clips main.svml [--keep main.svrun] [--out clips.svrun]
//       Writes a Run whose only Targets are the paid outputs (generated videos and images). --keep carries over
//       the build-record/satisfy selections of an existing Run so kept outputs are not generated again.
//   node tools/hypit-stage.mjs final main.svml --build <clips build id> [--target final.video] [--out main.svrun]
//       Writes the edit Run: the final Target, with every paid output taken from the finished clips Build.
//   node tools/hypit-stage.mjs recover [--project .] [--download <dir>]
//       Lists every OpenRouter video job the project has submitted with its status, model and cost, and with
//       --download saves the finished ones, so nothing paid for is lost after a failed Build.
//
// Paths are relative to the Source's directory, which must be the Hypit project root.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Author modules whose Surfaces submit paid generation requests. */
const PAID_MODULES = /^@hypit\/(seedance|gpt-image|nano-banana|grok-imagine|minimax-h3|seedream|wan|pixverse|fishaudio-speech|elevenlabs-speech|mimo-speech)(\/[a-z-]+)?@/;

function fail(message) {
  console.error(`hypit-stage: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") {
    console.error(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    process.exit(command ? 0 : 1);
  }
  const options = { command, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const value = rest[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

/** Attributes of one start tag, keeping {expressions} as written. */
function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([\w:-]+)=(?:"([^"]*)"|\{([^}]*)\})/g)) result[match[1]] = match[2] ?? `{${match[3]}}`;
  return result;
}

/** Every start tag with its prefix, local name, attributes and 1-based line. */
function elements(source) {
  const lines = source.split("\n");
  const offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const lineOf = (index) => { let lo = 0, hi = offsets.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offsets[mid] <= index) lo = mid; else hi = mid - 1; } return lo + 1; };
  const out = [];
  for (const match of source.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length)).matchAll(/<([\w-]+):([\w-]+)\b([^>]*?)\/?>/g)) {
    out.push({ prefix: match[1], name: match[2], attrs: attributes(match[3]), line: lineOf(match.index), index: match.index, raw: match[0] });
  }
  return out;
}

function paidPrefixes(source) {
  const prefixes = new Set();
  for (const match of source.matchAll(/<import\s+as="([\w-]+)"\s+from="([^"]+)"/g)) if (PAID_MODULES.test(match[2])) prefixes.add(match[1]);
  return prefixes;
}

/** Paid generation elements and the public output each produces. */
function paidOutputs(source) {
  const paid = paidPrefixes(source);
  return elements(source).filter((e) => paid.has(e.prefix) && e.attrs.id && /Video$|Image$|VoiceDesign$|Speech$/.test(e.name))
    .map((e) => ({ id: e.attrs.id, output: `${e.attrs.id}.${/Video$/.test(e.name) ? "video" : /Image$/.test(e.name) ? "image" : "reference"}`, element: e }));
}

function mediaSeconds(path) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], { encoding: "utf8" });
  if (result.error) fail("ffprobe is required for lint");
  const seconds = Number(result.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

// ---------- lint ----------

function lint(svmlPath) {
  const source = readFileSync(svmlPath, "utf8");
  const root = dirname(svmlPath);
  const all = elements(source);
  const errors = [], warnings = [];
  const clock = all.find((e) => e.prefix && e.name === "Clock" && e.attrs["frame-rate"]);
  if (!clock) fail("no Clock with a frame-rate found");
  const fps = Number(clock.attrs["frame-rate"]);
  // Window and Instant ids live in their Timeline's namespace (story.x) and may reuse a media element's id.
  const byId = new Map(all.filter((e) => e.attrs.id && !["Window", "Instant", "Timeline"].includes(e.name)).map((e) => [e.attrs.id, e]));

  /** Frames of a media extent `{X.extent}` where X is a Normalize of a local asset or a generated clip. */
  const extentCache = new Map();
  function extentFrames(reference, where) {
    const id = reference.replace(/^\{|\}$/g, "").replace(/\.extent$/, "");
    if (extentCache.has(id)) return extentCache.get(id);
    let frames;
    const normalize = byId.get(id);
    const sourceRef = normalize?.attrs.source?.replace(/^\{|\}$/g, "");
    const sourceId = sourceRef?.split(".")[0];
    const sourceElement = sourceId ? byId.get(sourceId) : undefined;
    if (sourceElement?.attrs.src) {
      const file = resolve(root, sourceElement.attrs.src);
      const seconds = existsSync(file) ? mediaSeconds(file) : undefined;
      if (seconds === undefined) warnings.push(`line ${where}: cannot measure ${sourceElement.attrs.src}; ${id}.extent not checked`);
      else frames = Math.floor(seconds * fps + 1e-6);
    } else if (sourceElement?.attrs.duration && Number(sourceElement.attrs.duration) > 0) {
      frames = Math.round(Number(sourceElement.attrs.duration) * fps);
    } else {
      warnings.push(`line ${where}: ${id}.extent has no known length; not checked`);
    }
    extentCache.set(id, frames);
    return frames;
  }

  /** Frames for an exact duration literal: 12f, 250ms, 1.5s. */
  function literalFrames(text, where) {
    const match = /^(\d+(?:\.\d+)?)(f|ms|s)$/.exec(text.trim());
    if (!match) return undefined;
    const value = Number(match[1]);
    const frames = match[2] === "f" ? value : match[2] === "ms" ? (value / 1000) * fps : value * fps;
    if (Math.abs(frames - Math.round(frames)) > 1e-6) errors.push(`line ${where}: ${text} is not a whole number of frames at ${fps} fps`);
    return Math.round(frames);
  }

  for (const timeline of all.filter((e) => e.name === "Timeline")) {
    const close = source.indexOf("</", timeline.index);
    const windows = all.filter((e) => e.name === "Window" && e.index > timeline.index && e.index < close);
    const byWindow = new Map(windows.map((w) => [w.attrs.id, w]));
    const resolved = new Map();
    const resolving = new Set();
    let endFrames;

    function point(expression, where) {
      const text = expression.trim();
      const offset = /^(.+?)([+-])(\d+(?:\.\d+)?(?:f|ms|s))$/.exec(text);
      if (offset) {
        const base = point(offset[1], where);
        const delta = literalFrames(offset[3], where);
        return base === undefined || delta === undefined ? undefined : base + (offset[2] === "+" ? delta : -delta);
      }
      if (text === "start") return 0;
      if (text === "end") return endFrames;
      const literal = literalFrames(text, where);
      if (literal !== undefined) return literal;
      const bound = /^([\w-]+)\.(start|end)$/.exec(text);
      if (bound && byWindow.has(bound[1])) {
        const window = resolveWindow(byWindow.get(bound[1]));
        return window ? window[bound[2] === "start" ? 0 : 1] : undefined;
      }
      warnings.push(`line ${where}: cannot evaluate "${text}"; not checked`);
      return undefined;
    }

    function resolveWindow(window) {
      const id = window.attrs.id;
      if (resolved.has(id)) return resolved.get(id);
      if (resolving.has(id)) { errors.push(`line ${window.line}: Window ${id} depends on itself`); return undefined; }
      resolving.add(id);
      const { from, until } = window.attrs;
      const span = window.attrs.for;
      const length = span === undefined ? undefined : span.startsWith("{") ? extentFrames(span, window.line) : literalFrames(span, window.line);
      let start, stop;
      if (from !== undefined && until !== undefined) { start = point(from, window.line); stop = point(until, window.line); }
      else if (from !== undefined && span !== undefined) { start = point(from, window.line); stop = start === undefined || length === undefined ? undefined : start + length; }
      else if (until !== undefined && span !== undefined) { stop = point(until, window.line); start = stop === undefined || length === undefined ? undefined : stop - length; }
      else errors.push(`line ${window.line}: Window ${id} needs exactly two of from, until and for`);
      resolving.delete(id);
      const value = start === undefined || stop === undefined ? undefined : [start, stop];
      resolved.set(id, value);
      return value;
    }

    endFrames = point(timeline.attrs.end ?? "", timeline.line);
    if (endFrames === undefined) { warnings.push(`line ${timeline.line}: Timeline ${timeline.attrs.id} end not evaluated; overruns not checked`); }
    for (const window of windows) {
      const value = resolveWindow(window);
      if (!value) continue;
      const [start, stop] = value;
      const where = `line ${window.line}: Window ${window.attrs.id} (${start}f to ${stop}f)`;
      if (stop <= start) errors.push(`${where} is empty or reversed`);
      if (start < 0) errors.push(`${where} starts before the Timeline`);
      if (endFrames !== undefined && stop > endFrames) {
        errors.push(`${where} ends ${stop - endFrames} frame(s) after Timeline ${timeline.attrs.id} ends at ${endFrames}f`);
      }
    }
    // A clip played over a Window longer than its media runs out of picture or sound.
    for (const clip of all.filter((e) => e.name === "Clip" && e.attrs.during)) {
      const windowId = clip.attrs.during.replace(/^\{|\}$/g, "").split(".").pop();
      const value = resolved.get(windowId);
      const mediaRef = (clip.attrs.media ?? clip.attrs.source ?? "").replace(/^\{|\}$/g, "");
      if (!value || !mediaRef.endsWith(".media")) continue;
      const media = extentFrames(`{${mediaRef.replace(/\.media$/, "")}.extent}`, clip.line);
      if (media !== undefined && value[1] - value[0] > media) {
        errors.push(`line ${clip.line}: Clip ${clip.attrs.id} lasts ${value[1] - value[0]}f but its media is only ${media}f`);
      }
    }
  }

  for (const out of paidOutputs(source)) {
    const duration = out.element.attrs.duration;
    if (duration !== undefined && /Video$/.test(out.element.name) && out.element.prefix && !/^-?\d+$/.test(duration)) {
      errors.push(`line ${out.element.line}: ${out.id} duration "${duration}" must be whole seconds`);
    }
  }
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
  console.log(errors.length ? `✗ ${errors.length} error(s): fix them before building` : `✓ every Window fits its Timeline (${warnings.length} warning(s))`);
  process.exitCode = errors.length ? 1 : 0;
}

// ---------- clips and final ----------

function keptSelections(svrunPath) {
  if (!svrunPath) return { records: [], satisfies: [] };
  const text = readFileSync(svrunPath, "utf8");
  return { records: [...text.matchAll(/<build-record\b[^>]*\/>/g)].map((m) => m[0]), satisfies: [...text.matchAll(/<satisfy\b[^>]*\/>/g)].map((m) => m[0]) };
}

function writeRun(path, author, targets, records, satisfies, comment) {
  const lines = ['<?svml using="@hypit/markup/run@1"?>', '<svrun version="1">', `  <author source="./${author}"/>`,
    ...targets.map((t) => `  <target output="${t}"/>`), ...(comment ? [`  <!-- ${comment} -->`] : []),
    ...records.map((r) => `  ${r}`), ...satisfies.map((s) => `  ${s}`), "</svrun>", ""];
  writeFileSync(path, lines.join("\n"));
}

function clips(svmlPath, options) {
  const source = readFileSync(svmlPath, "utf8");
  const outputs = paidOutputs(source);
  if (!outputs.length) fail("no paid generation outputs found in this Source");
  const kept = keptSelections(options.keep);
  const out = resolve(options.out ?? join(dirname(svmlPath), "clips.svrun"));
  writeRun(out, basename(svmlPath), outputs.map((o) => o.output), kept.records, kept.satisfies,
    kept.records.length ? "Kept selections: these outputs are reused, not generated." : "");
  console.log(`Wrote ${out}: ${outputs.length} paid output(s): ${outputs.map((o) => o.output).join(", ")}`);
  console.log("Next: hypit check, hypit plan, hypit pricing, then hypit build on it. Review the outputs before the edit stage.");
}

function hypit(args) {
  const result = spawnSync("hypit", args, { encoding: "utf8" });
  return result.error ? undefined : result;
}

function final(svmlPath, options) {
  if (!options.build) fail("final needs --build <clips build id>");
  const source = readFileSync(svmlPath, "utf8");
  const outputs = paidOutputs(source);
  const status = hypit(["status", options.build, "--json", "--project", dirname(svmlPath)]);
  if (status?.status === 0) {
    const json = JSON.parse(status.stdout.slice(status.stdout.indexOf("{")));
    const state = json.build?.result?.state;
    if (state !== "complete") fail(`clips build ${options.build} is ${state ?? "unknown"}, not complete; recover or rerun it first`);
  } else {
    console.log("note: hypit is not on PATH here, so the clips build's state was not checked");
  }
  const id = (o) => `paid-${o.id}`;
  const out = resolve(options.out ?? join(dirname(svmlPath), "main.svrun"));
  writeRun(out, basename(svmlPath), [options.target ?? "final.video"],
    outputs.map((o) => `<build-record id="${id(o)}" build="${options.build}" output="${o.output}"/>`),
    outputs.map((o) => `<satisfy output="${o.output}" candidate="${id(o)}"/>`),
    `Every paid output comes from clips build ${options.build}; this stage only edits and renders.`);
  console.log(`Wrote ${out}: ${options.target ?? "final.video"} reusing ${outputs.length} paid output(s) from ${options.build}`);
  console.log("Next: lint, then hypit pricing (expect no Provider charge), then hypit build.");
}

// ---------- recover ----------

function jobIds(directory) {
  const ids = new Set();
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (info.size < 64 * 1024 * 1024) for (const match of readFileSync(full, "latin1").matchAll(/gen-vid-[A-Za-z0-9_-]+/g)) ids.add(match[0]);
    }
  };
  if (existsSync(directory)) walk(directory);
  return [...ids].sort();
}

async function recover(options) {
  const project = resolve(options.project ?? ".");
  const ids = jobIds(join(project, ".hypit"));
  if (!ids.length) return console.log("No OpenRouter video jobs recorded in this project.");
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) fail("recover needs OPENROUTER_API_KEY");
  const base = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  let total = 0, unreadable = 0, lastStatus = 0;
  for (const id of ids) {
    const response = await fetch(`${base}/videos/${id}`, { headers: { authorization: `Bearer ${key}` } });
    const job = await response.json().catch(() => ({}));
    if (!response.ok) { unreadable++; lastStatus = response.status; }
    const cost = Number(job.usage?.cost ?? job.cost ?? 0);
    total += cost;
    let saved = "";
    if (options.download && job.status === "completed") {
      const target = join(resolve(options.download), `${id}.mp4`);
      if (!existsSync(target)) {
        const content = await fetch(`${base}/videos/${id}/content`, { headers: { authorization: `Bearer ${key}` } });
        if (content.ok) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(await content.arrayBuffer())); saved = ` → ${target}`; }
        else saved = ` (download HTTP ${content.status})`;
      } else saved = " (already saved)";
    }
    console.log(`${id}  ${response.ok ? job.status : `HTTP ${response.status}`}  ${job.model ?? ""}  $${cost.toFixed(4)}${saved}`);
  }
  if (unreadable === ids.length) {
    const why = lastStatus === 401 ? "OpenRouter rejected the API key; set a valid OPENROUTER_API_KEY"
      : lastStatus === 402 ? "the OpenRouter balance is too low" : `OpenRouter answered HTTP ${lastStatus}`;
    fail(`could not read any of ${ids.length} job(s): ${why}. Their status and cost are unknown, not zero.`);
  }
  if (unreadable) console.log(`warning: ${unreadable} of ${ids.length} job(s) could not be read; their cost is not included below.`);
  console.log(`${ids.length} job(s), $${total.toFixed(4)} reported. A completed job that no Build collected can be reused as a <file> Candidate.`);
}

const options = parseArgs(process.argv.slice(2));
const svml = options.positional[0] ? resolve(options.positional[0]) : undefined;
if (["lint", "clips", "final"].includes(options.command) && (!svml || !existsSync(svml))) fail(`${options.command} needs an existing .svml file`);
if (options.command === "lint") lint(svml);
else if (options.command === "clips") clips(svml, options);
else if (options.command === "final") final(svml, options);
else if (options.command === "recover") await recover(options);
else fail(`unknown command ${options.command}; use lint, clips, final or recover`);
