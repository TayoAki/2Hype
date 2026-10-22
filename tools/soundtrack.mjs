#!/usr/bin/env node
// Build a template's soundtrack: our voice lines on the reference's phrase timings, and music at its tempo.
// Needs ffmpeg/ffprobe on PATH and OPENROUTER_API_KEY. No npm dependencies.
//
//   node tools/soundtrack.mjs --template template.json --out assets/audio
//        [--voice <ElevenLabs preset>] [--music <file> | --music-prompt "<brief>"] [--lufs -14]
//
// Voice: every voiceover.phrases[].line is spoken by an ElevenLabs preset (elevenlabs/eleven-v3 through OpenRouter,
// the voice from --voice or voiceover.voicePreset), trimmed of silence, sped up (at most 1.25x) when it runs longer
// than its phrase, and placed at the phrase's start. Music: --music, or a new Lyria 3 track from --music-prompt
// (instrumental). Its tempo is measured and stretched to music.tempoBpm, then shifted so a beat falls at
// music.firstBeat. When voiceover.musicDucks is true the music ducks under the voice. Writes voice.wav, music.wav,
// mix.wav (mastered to --lufs) and soundtrack.json.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const templatePath = option("--template"), out = option("--out");
if (!templatePath || !out || !process.env.OPENROUTER_API_KEY) {
  console.error("Usage: OPENROUTER_API_KEY=... node tools/soundtrack.mjs --template template.json --out <dir> [--voice <preset>] [--music <file> | --music-prompt <brief>] [--lufs -14]");
  process.exit(1);
}
const template = JSON.parse(readFileSync(resolve(templatePath), "utf8"));
const dir = resolve(out);
mkdirSync(dir, { recursive: true });
const duration = template.duration;
const lufs = Number(option("--lufs", -14));
const round = (n) => Math.round(n * 1000) / 1000;
const headers = { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "content-type": "application/json" };
const report = { format: "soundtrack@1", phrases: [], music: null, cost: 0 };

function run(command, list, encoding = "utf8") {
  const result = spawnSync(command, list, { encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw new Error(`${command} could not start (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim().split("\n").slice(-3).join(" ")}`);
  return result;
}
const seconds = (file) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout);

// ---------- voice ----------
const voice = template.voiceover ?? {};
const phrases = (voice.phrases ?? []).filter((p) => String(p.line ?? "").trim());
const preset = option("--voice", voice.voicePreset ?? "jessica");
const voiceModel = voice.voiceModel ?? "elevenlabs/eleven-v3";
const TAG = { calm: "calm", warm: "warm", upbeat: "cheerful", high: "excited" };
for (const p of phrases) {
  const raw = join(dir, `phrase-${p.phrase}.mp3`);
  const response = await fetch("https://openrouter.ai/api/v1/audio/speech", { method: "POST", headers,
    body: JSON.stringify({ model: voiceModel, voice: preset, response_format: "mp3", input: `[${TAG[p.energy] ?? "cheerful"}] ${p.line}` }) });
  if (!response.ok) throw new Error(`speech ${response.status}: ${(await response.text()).slice(0, 300)}`);
  writeFileSync(raw, Buffer.from(await response.arrayBuffer()));
  // Trim leading and trailing silence, then fit the phrase window (never slower, at most 1.25x faster).
  const trimmed = join(dir, `phrase-${p.phrase}-trim.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", raw, "-af",
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse",
    "-ar", "48000", "-ac", "2", trimmed]);
  const spoken = seconds(trimmed), window = p.end - p.start;
  const tempo = Math.min(1.25, Math.max(1, spoken / window));
  const fitted = join(dir, `phrase-${p.phrase}-fit.wav`);
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", trimmed, "-af", `atempo=${tempo.toFixed(4)}`, fitted]);
  const placed = seconds(fitted);
  report.phrases.push({ phrase: p.phrase, start: p.start, window: round(window), spoken: round(spoken), tempo: round(tempo), placed: round(placed),
    overrun: round(Math.max(0, placed - window)), file: fitted });
  if (placed > window + 0.15) console.warn(`  phrase ${p.phrase} runs ${round(placed - window)}s past its window even at ${tempo.toFixed(2)}x; shorten the line`);
}
const voiceFile = join(dir, "voice.wav");
if (report.phrases.length) {
  const inputs = report.phrases.flatMap((p) => ["-i", p.file]);
  const delays = report.phrases.map((p, i) => `[${i}]adelay=${Math.round(p.start * 1000)}|${Math.round(p.start * 1000)}[v${i}]`).join(";");
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...inputs, "-filter_complex",
    `${delays};${report.phrases.map((_, i) => `[v${i}]`).join("")}amix=inputs=${report.phrases.length}:normalize=0,apad=whole_dur=${duration},atrim=0:${duration}`,
    "-ar", "48000", "-ac", "2", voiceFile]);
}

// ---------- music ----------
/** Tempo and first beat from an onset envelope (the same method as shot-list.mjs --metrics). */
function measureBeat(file) {
  const rate = 11025, hop = 128, hopSeconds = hop / rate;
  const pcm = run("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], "buffer").stdout;
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const count = Math.floor(samples.length / hop), envelope = new Float64Array(count);
  let previous = 0;
  for (let i = 0; i < count; i++) {
    let energy = 0;
    for (let k = i * hop; k < (i + 1) * hop; k++) energy += samples[k] * samples[k];
    const level = Math.log1p(energy / hop);
    envelope[i] = Math.max(0, level - previous);
    previous = level;
  }
  const average = envelope.reduce((a, b) => a + b, 0) / count, centred = envelope.map((v) => v - average);
  const minLag = Math.floor(60 / 180 / hopSeconds), maxLag = Math.ceil(60 / 70 / hopSeconds), score = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < count; i++) sum += centred[i] * centred[i - lag];
    score[lag] = (sum / (count - lag)) * Math.exp(-0.5 * Math.log2(60 / (lag * hopSeconds) / 120) ** 2);
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag;
  const [a, b, c] = [score[best - 1] ?? score[best], score[best], score[best + 1] ?? score[best]];
  const period = best + (a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
  let phase = 0, phaseScore = -Infinity;
  for (let offset = 0; offset < period; offset += 1) {
    let sum = 0;
    for (let t = offset; t < count; t += period) sum += Math.max(envelope[Math.floor(t)], envelope[Math.min(count - 1, Math.floor(t) + 1)]);
    if (sum > phaseScore) { phaseScore = sum; phase = offset; }
  }
  return { bpm: 60 / (period * hopSeconds), firstBeat: phase * hopSeconds };
}

let musicSource = option("--music");
const musicPrompt = option("--music-prompt");
if (!musicSource && musicPrompt) {
  const bpm = Math.round(template.music?.tempoBpm ?? 120);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers,
    body: JSON.stringify({ model: "google/lyria-3-clip-preview", stream: true, modalities: ["text", "audio"],
      messages: [{ role: "user", content: `${musicPrompt} Exactly ${bpm} BPM with a steady beat from the very first second, about ${Math.ceil(duration)} seconds, a clear button ending. Instrumental only: no vocals, no lyrics.` }] }) });
  if (!response.ok) throw new Error(`music ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const chunks = [];
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const part of response.body) {
    buffer += decoder.decode(part, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const event = JSON.parse(line.slice(6));
      if (event.usage?.cost !== undefined) report.cost += event.usage.cost;
      for (const choice of event.choices ?? []) if (choice.delta?.audio?.data) chunks.push(choice.delta.audio.data);
    }
  }
  if (!chunks.length) throw new Error("Lyria returned no audio");
  musicSource = join(dir, "music-generated.mp3");
  writeFileSync(musicSource, Buffer.from(chunks.join(""), "base64"));
}
const musicFile = join(dir, "music.wav");
if (musicSource) {
  const measured = measureBeat(musicSource);
  const targetBpm = template.music?.tempoBpm, targetBeat = template.music?.firstBeat ?? 0;
  // Stretch to the reference tempo (pitch kept), then shift so a beat lands where the reference's first beat does.
  const stretch = targetBpm && measured.bpm > 0 ? Math.min(1.25, Math.max(0.8, targetBpm / measured.bpm)) : 1;
  const stretched = join(dir, "music-stretched.wav");
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", musicSource, "-af", `atempo=${stretch.toFixed(5)}`, "-ar", "48000", "-ac", "2", stretched]);
  const beat = 60 / (measured.bpm * stretch), first = measured.firstBeat / stretch;
  let shift = ((targetBeat - first) % beat + beat) % beat;
  if (shift > beat / 2) shift -= beat;  // trim the start when that is the shorter move
  const shiftFilter = shift >= 0 ? `adelay=${Math.round(shift * 1000)}|${Math.round(shift * 1000)}` : `atrim=start=${(-shift).toFixed(4)},asetpts=PTS-STARTPTS`;
  const ducks = voice.musicDucks && report.phrases.length;
  const chain = `[0]${shiftFilter},apad=whole_dur=${duration},atrim=0:${duration},afade=t=out:st=${(duration - 0.6).toFixed(3)}:d=0.6`;
  if (ducks) {
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", stretched, "-i", voiceFile, "-filter_complex",
      `${chain}[m];[m][1]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350:makeup=1`, "-ar", "48000", "-ac", "2", musicFile]);
  } else {
    run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", stretched, "-filter_complex", chain, "-ar", "48000", "-ac", "2", musicFile]);
  }
  const after = measureBeat(musicFile);
  report.music = { source: musicSource, measuredBpm: round(measured.bpm), stretch: round(stretch), shift: round(shift), resultBpm: round(after.bpm),
    targetBpm: targetBpm ?? null, firstBeat: round(after.firstBeat), targetFirstBeat: targetBeat, ducked: Boolean(ducks) };
}

// ---------- mix ----------
const mixFile = join(dir, "mix.wav");
const stems = [report.phrases.length && voiceFile, musicSource && musicFile].filter(Boolean);
if (stems.length) {
  const premix = join(dir, "premix.wav");
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...stems.flatMap((f) => ["-i", f]), "-filter_complex",
    stems.length === 2 ? "[0]volume=1.0[v];[1]volume=0.55[m];[v][m]amix=inputs=2:normalize=0" : "[0]anull", "-ar", "48000", "-ac", "2", premix]);
  const first = run("ffmpeg", ["-hide_banner", "-nostats", "-i", premix, "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=7:print_format=json`, "-f", "null", "-"]).stderr;
  const m = JSON.parse(first.slice(first.lastIndexOf("{"), first.lastIndexOf("}") + 1));
  run("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", premix, "-af",
    `loudnorm=I=${lufs}:TP=-1.5:LRA=7:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
    "-ar", "48000", "-ac", "2", mixFile]);
  report.mix = { file: mixFile, lufs };
}
writeFileSync(join(dir, "soundtrack.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const p of report.phrases) console.log(`  phrase ${p.phrase} at ${p.start}s: ${p.spoken}s spoken for a ${p.window}s window, ${p.tempo}x${p.overrun ? `, ${p.overrun}s over` : ""}`);
if (report.music) console.log(`  music ${report.music.measuredBpm} BPM x${report.music.stretch} -> ${report.music.resultBpm} BPM (target ${report.music.targetBpm}), shifted ${report.music.shift}s, beat at ${report.music.firstBeat}s${report.music.ducked ? ", ducked under the voice" : ""}`);
console.log(`Wrote ${dir}/voice.wav, music.wav, mix.wav (${lufs} LUFS) and soundtrack.json; generation cost $${report.cost.toFixed(4)} (speech billed separately).`);
