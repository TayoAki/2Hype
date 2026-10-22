// Remake Studio engine: one folder per project, the reference-locked remake as a row of steps.
//
//   analyze    cut the reference into shots (frames, labels, template, spec)            tools/shot-list.mjs
//   draft      our version of every shot, the cast, the sets and the voice from a brief  OpenRouter (Claude)
//   cast       character sheets, a world image and app screens                         GPT Image 2
//   plates     one empty-set still per setup the reference repeats                     tools/keyframes.mjs
//   stills     each shot's opening still on its plate (close-ups: app laid on)          tools/keyframes.mjs
//   check      every still against its reference slot                                   tools/keyframes.mjs
//   animate    one Seedance clip per shot from its still, cut into its slot            keyframes.mjs + assemble.mjs
//   soundtrack our voice lines on the reference's phrase timings, music at its tempo   tools/soundtrack.mjs
//   final      every slot strung together on the reference's timeline (stills stand in for shots not animated)
//   compare    the cut against the reference: the format-critical score                tools/shot-list.mjs --compare
//
// The web app (/studio), the MCP tools and the command line (tools/studio/cli.mjs) all drive this module, so a
// button, a chat message and a shell command do the same thing. Paid steps call OpenRouter with the server's key;
// estimate() prices every step before it runs. One step runs at a time per project; its log is logs/<step>.log.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const IMAGE = 0.053;  // GPT Image 2 at 1K with references, measured
const RATES = { "mini-720p": 0.0756, "fast-720p": 0.0907, "standard-720p": 0.1512, "standard-1080p": 0.3742 };  // Seedance, USD per second
export const STEPS = [
  { id: "analyze", label: "Cut the reference into shots" },
  { id: "draft", label: "Draft our version from the brief" },
  { id: "cast", label: "Cast sheets, world and app screens" },
  { id: "plates", label: "Set plates" },
  { id: "stills", label: "Opening stills" },
  { id: "check", label: "Check stills against the reference" },
  { id: "animate", label: "Animate shots" },
  { id: "soundtrack", label: "Voice and music" },
  { id: "final", label: "String the cut together" },
  { id: "compare", label: "Format check of the cut" },
];
// Buttons that run several steps in a row.
export const CHAINS = { images: ["plates", "stills", "check"], video: ["animate", "soundtrack", "final"], all: ["draft", "cast", "plates", "stills", "check"] };

const pad = (n) => String(n).padStart(2, "0");
const now = () => new Date().toISOString();
const slug = (text) => String(text || "remake").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "remake";
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };

export function createStudio({ root, hypitHome, python = "python3", env = process.env, draftModel = env.STUDIO_DRAFT_MODEL ?? "anthropic/claude-opus-5.5" }) {
  root = resolve(root);
  hypitHome = resolve(hypitHome);
  mkdirSync(root, { recursive: true });
  const tools = join(hypitHome, "tools");
  const hypitBin = join(hypitHome, "bin", "hypit.mjs");
  const running = new Map();  // project id -> { step, steps, child, startedAt }

  const dir = (id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(id))) throw new Error(`no project "${id}"`);
    const path = join(root, id);
    if (!existsSync(join(path, "project.json"))) throw new Error(`no project "${id}"`);
    return path;
  };
  const load = (id) => readJson(join(dir(id), "project.json"), null);
  const save = (project) => writeJson(join(root, project.id, "project.json"), { ...project, updatedAt: now() });
  const update = (id, change) => { const p = load(id); change(p); save(p); return p; };
  const event = (id, text) => update(id, (p) => { p.events = [...(p.events ?? []), { at: now(), text }].slice(-60); });

  /** A path inside a project, refusing escapes. */
  function file(id, rel) {
    const base = dir(id), path = resolve(base, String(rel ?? ""));
    if (path !== base && !path.startsWith(base + sep)) throw new Error("path outside the project");
    return path;
  }

  // ---------- projects ----------

  function hypitProject(path, name) {
    writeJson(join(path, "package.json"), { name: slug(name), version: "0.0.0", private: true, type: "module", hypit: { project: true } });
    writeJson(join(path, "hypit.runtime.json"), {
      format: "hypit.runtime-local@1", dataRoot: ".hypit/runtimes/local", credentials: { env: { use: "@hypit/credential-store-env" } },
      endpoints: {
        "media.local": { use: "@hypit/media-local" },
        "openrouter.default": { use: "@hypit/provider-openrouter", pool: "openrouter.default",
          config: { apiKey: { store: "env", key: "OPENROUTER_API_KEY" }, jobLedgerPath: "./openrouter-jobs.json" } },
      },
      bindings: Object.fromEntries(["@hypit/gpt-image@1#gpt-image-2", "@hypit/seedance@1#seedance-2-mini", "@hypit/seedance@1#seedance-2-fast",
        "@hypit/seedance@1#seedance-2"].map((b) => [b, "openrouter.default"])),
    });
    mkdirSync(join(path, ".hypit"), { recursive: true });
    writeFileSync(join(path, ".hypit", "runtime"), "hypit.runtime.json\n");
    writeFileSync(join(path, ".hypit", ".gitignore"), "*\n");
  }

  /** A new project around a reference video already on disk (the upload route streams it to a temporary file). */
  function create({ name, source, filename }) {
    const id = `${slug(name)}-${randomBytes(2).toString("hex")}`;
    const path = join(root, id);
    mkdirSync(join(path, "reference"), { recursive: true });
    const ext = (extname(filename ?? source) || ".mp4").toLowerCase();
    const target = join(path, "reference", `reference${ext}`);
    renameSync(source, target);
    hypitProject(path, name);
    const probe = probeVideo(target);
    writeJson(join(path, "project.json"), { format: "remake-studio.project@1", id, name: String(name || "Untitled remake").slice(0, 80), createdAt: now(),
      reference: { file: relative(path, target), ...probe }, brief: null, steps: {}, decisions: {}, costs: {}, events: [{ at: now(), text: "Reference uploaded" }] });
    return id;
  }

  function list() {
    return readdirSync(root).filter((id) => existsSync(join(root, id, "project.json"))).map((id) => {
      const p = readJson(join(root, id, "project.json"), {});
      return { id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, running: running.get(id)?.step ?? null,
        done: Object.entries(p.steps ?? {}).filter(([, s]) => s.state === "done").map(([k]) => k), cost: total(p) };
    }).sort((a, b) => String(b.updatedAt ?? b.createdAt).localeCompare(String(a.updatedAt ?? a.createdAt)));
  }
  const total = (p) => Math.round(Object.values(p.costs ?? {}).reduce((a, b) => a + b, 0) * 100) / 100;

  /** Everything the app shows: steps, shots with their reference frames, our stills and clips, checks, costs. */
  function get(id) {
    const path = dir(id), p = load(id);
    const shots = readJson(join(path, "analysis", "shots.json"), null);
    const template = readJson(join(path, "template.json"), null) ?? readJson(join(path, "analysis", "template.json"), null);
    const check = readJson(join(path, "stills", "check.json"), null);
    const rel = (...parts) => { const full = join(path, ...parts); return existsSync(full) ? relative(path, full) : null; };
    const slots = (template?.slots ?? []).map((s) => {
      const n = pad(s.slot), ref = shots?.shots?.find((r) => r.shot === s.slot) ?? {};
      return {
        slot: s.slot, start: s.start, duration: s.duration, startFrame: s.startFrame, frames: s.frames, setup: s.setup ?? null, groupWith: s.groupWith ?? null,
        generate: s.generate !== false, prompt: s.prompt ?? "", firstFrame: s.firstFrame ?? "", waive: s.waive ?? null,
        labels: Object.fromEntries(["beat", "shot_size", "angle", "camera_move", "people_count", "extras_count", "hands_in_frame", "medium", "device", "held_prop",
          "setting", "facing", "subject_position", "subject_scale", "depth_of_field", "characters", "layout_note", "vo_words"].filter((k) => s[k] !== undefined).map((k) => [k, s[k]])),
        reference: [1, 2, 3].map((k) => rel("analysis", "thumbs", `shot-${String(s.slot).padStart(3, "0")}-${k}.jpg`)).filter(Boolean),
        stills: { first: rel("stills", `slot-${n}-ui.png`) ?? rel("stills", `slot-${n}.png`), last: rel("stills", `slot-${n}-last-ui.png`) ?? rel("stills", `slot-${n}-last.png`),
          plate: s.setup || s.groupWith ? rel("stills", `plate-${s.groupWith ?? s.setup}.png`) : null },
        clip: rel("slots", `slot-${n}.mp4`), take: rel("takes", `slot-${n}.mp4`),
        check: check?.slots?.[s.slot] ?? null, decision: p.decisions?.[s.slot] ?? null, billed: Math.min(15, Math.max(4, Math.ceil(s.duration + (template?.keyframes?.margin ?? 0.5)))),
        motion: ref.motion,
      };
    });
    const run = running.get(id);
    return {
      ...p, running: run ? { step: run.step, steps: run.steps, startedAt: run.startedAt, log: tail(join(path, "logs", `${run.step}.log`), 40) } : null,
      steps: Object.fromEntries(STEPS.map((s) => [s.id, { label: s.label, ...(p.steps?.[s.id] ?? { state: "idle" }) }])),
      reference: { ...p.reference, proxy: rel("reference", "proxy.mp4") },
      summary: shots ? { shots: shots.summary.shots, duration: shots.summary.duration, fps: shots.summary.fps, aspectRatio: shots.summary.aspectRatio,
        voice: template?.voiceover?.phrases?.map((v) => ({ phrase: v.phrase, start: v.start, end: v.end, words: v.words, role: v.role, line: v.line ?? "" })) ?? [],
        continuity: shots.summary.continuity ?? {} } : null,
      cast: template?.castMap ? Object.entries(template.castMap).map(([k, name]) => ({ id: k, name, sheet: rel("cast", `${slug(name)}.png`) })) : [],
      castSheets: (template?.references ?? []).filter((r) => r.kind === "cast").map((r) => ({ role: r.role, file: relative(path, resolve(path, r.path)) })),
      world: rel("cast", "world.png"), screens: Object.entries(template?.screenDesigns ?? {}).map(([slot, d]) => ({ slot: Number(slot), before: d.before, after: d.after })),
      checkSummary: check ? { pass: Object.values(check.slots ?? {}).filter((x) => x.pass).length, total: Object.keys(check.slots ?? {}).length, lines: check.lines, cost: check.cost } : null,
      final: { video: rel("final", "final.mp4"), proxy: rel("final", "proxy.mp4") }, compare: readJson(join(path, "compare", "delta.json"), null),
      slots, estimate: estimate(id), total: total(p),
    };
  }

  // ---------- edits from the app ----------

  function setBrief(id, brief) {
    const clean = Object.fromEntries(["brand", "product", "offer", "audience", "tone", "style", "characters", "notes"].map((k) => [k, String(brief?.[k] ?? "").slice(0, 2000)]));
    update(id, (p) => { p.brief = clean; });
    event(id, "Brief saved");
    return clean;
  }

  /** Edit one shot (its prompt, opening frame or waivers) or a voice line; the stills check reads the template. */
  function editSlot(id, slot, change) {
    const path = join(dir(id), "template.json"), t = readJson(path, null);
    if (!t) throw new Error("draft the template first");
    const s = t.slots.find((x) => x.slot === Number(slot));
    if (!s) throw new Error(`no slot ${slot}`);
    if (typeof change.prompt === "string") s.prompt = change.prompt.slice(0, 1200);
    if (typeof change.firstFrame === "string") { if (change.firstFrame.trim()) s.firstFrame = change.firstFrame.slice(0, 1200); else delete s.firstFrame; }
    if (change.waive && typeof change.waive === "object") s.waive = { ...(s.waive ?? {}), ...change.waive };
    writeJson(path, t);
    return s;
  }
  function editLine(id, phrase, line) {
    const path = join(dir(id), "template.json"), t = readJson(path, null);
    const p = t?.voiceover?.phrases?.find((x) => x.phrase === Number(phrase));
    if (!p) throw new Error(`no voice phrase ${phrase}`);
    p.line = String(line).slice(0, 400);
    writeJson(path, t);
    return p;
  }

  const MODELS = Object.keys(RATES);
  function setDecisions(id, decisions) {
    const clean = {};
    for (const [slot, d] of Object.entries(decisions ?? {})) {
      if (!/^\d+$/.test(slot)) continue;
      clean[slot] = { model: d?.model === "skip" || MODELS.includes(d?.model) ? d.model : "mini-720p", approve: !!d?.approve, ...(d?.note ? { note: String(d.note).slice(0, 500) } : {}) };
    }
    update(id, (p) => { p.decisions = { ...(p.decisions ?? {}), ...clean }; });
    return load(id).decisions;
  }

  // ---------- estimates ----------

  function estimate(id) {
    const path = dir(id), p = load(id);
    const t = readJson(join(path, "template.json"), null) ?? readJson(join(path, "analysis", "template.json"), null);
    const slots = t?.slots ?? [], generated = slots.filter((s) => s.generate !== false);
    const closeups = generated.filter((s) => s.device === "screen-closeup").length;
    const setups = Object.keys(t?.continuity?.setups ?? {}).length;
    const castCount = Object.keys(t?.castMap ?? t?.continuity?.characters ?? {}).length + 3;
    const margin = t?.keyframes?.margin ?? 0.5;
    let video = 0, seconds = 0;
    for (const s of generated) {
      const model = p.decisions?.[s.slot]?.model ?? "mini-720p";
      if (model === "skip") continue;
      const billed = Math.min(15, Math.max(4, Math.ceil(s.duration + margin)));
      seconds += billed;
      video += billed * RATES[model];
    }
    const r = (v) => Math.round(v * 100) / 100;
    return { analyze: r(0.02 * (slots.length || 20)), draft: 0.25, cast: r(IMAGE * (castCount + 1 + 2 * closeups)), plates: r(IMAGE * setups),
      stills: r(IMAGE * (generated.length + closeups)), check: 0.04, animate: r(video), animateSeconds: seconds, soundtrack: 0.1, final: 0, compare: 0.05 };
  }

  // ---------- running steps ----------

  function stop(id) {
    const run = running.get(id);
    if (!run) return false;
    run.stopped = true;
    run.child?.kill("SIGTERM");
    return true;
  }

  /** Start a step (or a chain of steps) in the background; resolves once it has started. */
  function run(id, step, options = {}) {
    const path = dir(id);
    if (running.has(id)) throw new Error(`${running.get(id).step} is already running`);
    const steps = CHAINS[step] ?? [step];
    for (const s of steps) if (!STEPS.some((x) => x.id === s)) throw new Error(`unknown step ${s}`);
    const job = { step: steps[0], steps, startedAt: now(), child: null, stopped: false };
    running.set(id, job);
    (async () => {
      for (const s of steps) {
        if (job.stopped) break;
        job.step = s;
        mkdirSync(join(path, "logs"), { recursive: true });
        writeFileSync(join(path, "logs", `${s}.log`), `${now()} ${s}\n`);
        update(id, (p) => { p.steps = { ...(p.steps ?? {}), [s]: { state: "running", startedAt: now() } }; });
        const before = await keyUsage();
        try {
          // OpenRouter bills a video when its job finishes, often after the step: record the larger of what the
          // balance moved and what the step planned to spend.
          const planned = (await STEP[s](id, path, options, job))?.planned ?? 0;
          const cost = Math.max(0, (await keyUsage()) - before, planned);
          update(id, (p) => { p.steps[s] = { ...p.steps[s], state: "done", finishedAt: now() }; p.costs = { ...(p.costs ?? {}), [s]: Math.round(((p.costs?.[s] ?? 0) + cost) * 1000) / 1000 }; });
          event(id, `${STEPS.find((x) => x.id === s).label}: done${cost > 0.001 ? ` ($${cost.toFixed(2)})` : ""}`);
        } catch (error) {
          const cost = Math.max(0, (await keyUsage()) - before);
          update(id, (p) => { p.steps[s] = { ...p.steps[s], state: job.stopped ? "stopped" : "failed", finishedAt: now(), error: String(error.message ?? error).slice(0, 2000) };
            p.costs = { ...(p.costs ?? {}), [s]: Math.round(((p.costs?.[s] ?? 0) + cost) * 1000) / 1000 }; });
          event(id, `${s} ${job.stopped ? "stopped" : `failed: ${String(error.message ?? error).slice(0, 200)}`}`);
          break;
        }
      }
      running.delete(id);
    })();
    return { started: steps };
  }

  /** Spawn a command in the project, appending its output to the step's log; rejects on a non-zero exit. */
  function cmd(path, job, command, list, { allowFail = false } = {}) {
    return new Promise((done, fail) => {
      const logPath = join(path, "logs", `${job.step}.log`);
      const log = createWriteStream(logPath, { flags: "a" });
      log.write(`$ ${[command, ...list].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ").replace(hypitHome, "<hypit>")}\n`);
      const child = spawn(command, list, { cwd: path, env: { ...env, FORCE_COLOR: "0" } });
      job.child = child;
      let out = "";
      const take = (chunk) => { const text = chunk.toString(); out += text; if (out.length > 2e6) out = out.slice(-1e6); log.write(text.replace(/\u001b\[[0-9;]*m/g, "")); };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", (error) => { log.end(); fail(error); });
      child.on("close", (code) => {
        log.end();
        job.child = null;
        if (code === 0 || allowFail) done({ code, out });
        else fail(new Error(`${command.split("/").pop()} exited with ${code}: ${out.trim().split("\n").filter((l) => !/UNDICI|trace-warnings/.test(l)).slice(-4).join(" | ")}`));
      });
    });
  }
  const node = (path, job, script, list, opts) => cmd(path, job, process.execPath, [script, ...list], opts);

  /** Build an .svrun with Hypit and fetch outputs (an existing file is moved to _old/ first: Hypit never overwrites). */
  async function build(path, job, svrun, outputs) {
    const started = await node(path, job, hypitBin, ["build", svrun]);
    const buildId = /bld_[A-Za-z0-9_]+/.exec(started.out)?.[0];
    if (!buildId) throw new Error("Hypit did not start a build");
    const status = await node(path, job, hypitBin, ["status", buildId, "--watch"], { allowFail: true });
    const failed = [];
    for (const { output, to } of outputs) {
      const target = join(path, to);
      if (existsSync(target)) {
        mkdirSync(join(path, "_old"), { recursive: true });
        renameSync(target, join(path, "_old", `${Date.now()}-${to.replace(/[\\/]/g, "_")}`));
      }
      mkdirSync(dirname(target), { recursive: true });
      const got = await node(path, job, hypitBin, ["get", buildId, "--output", output, "--to", to], { allowFail: true });
      if (got.code !== 0) failed.push(output);
    }
    if (failed.length === outputs.length) throw new Error(`build ${buildId} produced nothing (${/Outcome\s+(\w+)/.exec(status.out)?.[1] ?? "unknown"})`);
    if (failed.length) throw new Error(`build ${buildId}: ${failed.length} of ${outputs.length} outputs failed (${failed.slice(0, 6).join(", ")}); rerun to retry them`);
    return buildId;
  }
  const targetsOf = (path, svrun) => [...readFileSync(join(path, svrun), "utf8").matchAll(/output="([^"]+)"/g)].map((m) => m[1]);

  async function keyUsage() {
    if (!env.OPENROUTER_API_KEY) return 0;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(15000) });
      return (await response.json())?.data?.usage ?? 0;
    } catch { return 0; }
  }

  const STEP = {
    async analyze(id, path, _o, job) {
      const p = load(id), ref = join(path, p.reference.file);
      await node(path, job, join(tools, "shot-list.mjs"), [ref, "--out", "analysis", "--analyze", "--template", "--spec", "--metrics", "--concurrency", "3"], { allowFail: true })
        .then((r) => { if (!existsSync(join(path, "analysis", "template.json"))) throw new Error(`analysis failed: ${r.out.trim().split("\n").slice(-3).join(" | ")}`); });
      prepareAnalysis(id);
    },

    async draft(id, path) {
      const p = load(id);
      if (!p.brief?.brand) throw new Error("fill in the brief first (at least the brand)");
      const base = readJson(join(path, "analysis", "template.json"), null);
      if (!base) throw new Error("analyze the reference first");
      const spec = existsSync(join(path, "analysis", "VIDEO_SPEC.md")) ? readFileSync(join(path, "analysis", "VIDEO_SPEC.md"), "utf8") : "";
      const draft = await draftTemplate(base, spec, p.brief);
      writeJson(join(path, "draft.json"), draft);
      writeJson(join(path, "template.json"), buildTemplate(base, draft));
      return { planned: draft.cost ?? 0.25 };
    },

    async cast(id, path, _o, job) {
      const { t, draft, targets } = writeCastSources(id);
      if (targets.length) await build(path, job, "cast.svrun", targets.map((o) => ({ output: o, to: outputFile(o) })));
      writeJson(join(path, "template.json"), attachCast(t, draft, path));
      return { planned: targets.length * IMAGE };
    },

    async plates(id, path, _o, job) {
      await node(path, job, join(tools, "keyframes.mjs"), ["plates", "template.json", "--out", "."]);
      const targets = targetsOf(path, "plates.svrun");
      if (targets.length) await build(path, job, "plates.svrun", targets.map((o) => ({ output: o, to: `stills/${o.replace(/\.image$/, "")}.png` })));
      return { planned: targets.length * IMAGE };
    },

    async stills(id, path, options, job) {
      const only = options.only?.length ? ["--only", options.only.join(",")] : [];
      await node(path, job, join(tools, "keyframes.mjs"), ["stills", "template.json", "--out", ".", "--stills", "stills", ...only]);
      const stillTargets = targetsOf(path, "stills.svrun");
      await build(path, job, "stills.svrun", stillTargets.map((o) => ({ output: o, to: `stills/${o.replace(/\.image$/, "")}.png` })));
      const t = readJson(join(path, "template.json"), {});
      if (Object.keys(t.screenDesigns ?? {}).length) await node(path, job, join(tools, "keyframes.mjs"), ["screens", "template.json", "--stills", "stills", "--python", python]);
      return { planned: stillTargets.length * IMAGE };
    },

    async check(id, path, _o, job) {
      // Exit 2 means some shots miss the reference: that is the result, not a failure. No fresh check.json is.
      const started = Date.now(), report = join(path, "stills", "check.json");
      const r = await node(path, job, join(tools, "keyframes.mjs"), ["check", "template.json", "--stills", "stills"], { allowFail: true });
      if (!existsSync(report) || statSync(report).mtimeMs < started) throw new Error(r.out.trim().split("\n").slice(-2).join(" | "));
    },

    async animate(id, path, options, job) {
      const p = load(id);
      const decisions = { ...(p.decisions ?? {}) };
      if (options.only?.length) for (const s of readJson(join(path, "template.json"), { slots: [] }).slots) if (!options.only.includes(s.slot)) decisions[s.slot] = { ...(decisions[s.slot] ?? {}), model: "skip" };
      if (options.model) for (const k of Object.keys(decisions)) if (decisions[k].model !== "skip") decisions[k].model = options.model;
      writeJson(join(path, "decisions.json"), { format: "remake-review.decisions@1", decisions });
      await node(path, job, join(tools, "keyframes.mjs"), ["frames", "template.json", "--stills", "stills", "--out", ".", "--decisions", "decisions.json"]);
      const targets = targetsOf(path, "frames.svrun");
      if (!targets.length) throw new Error("no shots to animate (every shot is set to skip)");
      await build(path, job, "frames.svrun", targets.map((o) => ({ output: o, to: `takes/${o.replace(/\.video$/, "")}.mp4` })));
      await node(path, job, join(tools, "assemble.mjs"), ["--plan", "clips-plan.json", "--template", "template.json", "--takes", "takes", "--out", "slots"]);
      const plan = readJson(join(path, "clips-plan.json"), { clips: [] });
      return { planned: plan.clips.reduce((sum, c) => sum + c.seconds * (RATES[c.model] ?? RATES["mini-720p"]), 0) };
    },

    async soundtrack(id, path, _o, job) {
      const draft = readJson(join(path, "draft.json"), {});
      await node(path, job, join(tools, "soundtrack.mjs"), ["--template", "template.json", "--out", "audio", ...(draft.musicPrompt ? ["--music-prompt", draft.musicPrompt] : [])]);
    },

    async final(id, path, _o, job) {
      const t = readJson(join(path, "template.json"), null);
      if (!t) throw new Error("draft first");
      const fps = t.timelineFps ?? 24;
      mkdirSync(join(path, "final", "parts"), { recursive: true });
      const parts = [];
      for (const s of t.slots) {
        const n = pad(s.slot), out = join(path, "final", "parts", `slot-${n}.mp4`);
        const clip = join(path, "slots", `slot-${n}.mp4`);
        const still = [`stills/slot-${n}-ui.png`, `stills/slot-${n}.png`].map((x) => join(path, x)).find(existsSync);
        const vf = `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`;
        // An animated slot as cut; a slot not animated yet holds its still, so the cut always runs the reference's length.
        if (existsSync(clip)) ffmpeg(["-i", clip, "-vf", vf, "-frames:v", String(s.frames), "-an", "-c:v", "libx264", "-crf", "18", out]);
        else if (still) ffmpeg(["-loop", "1", "-i", still, "-vf", vf, "-frames:v", String(s.frames), "-c:v", "libx264", "-crf", "18", out]);
        else ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=1280x720:r=${fps}`, "-frames:v", String(s.frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
        parts.push(out);
      }
      writeFileSync(join(path, "final", "parts.txt"), parts.map((x) => `file '${x.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      const audio = join(path, "audio", "mix.wav");
      ffmpeg(["-f", "concat", "-safe", "0", "-i", join(path, "final", "parts.txt"), ...(existsSync(audio) ? ["-i", audio, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
        "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(path, "final", "final.mp4")]);
      proxy(join(path, "final", "final.mp4"), join(path, "final", "proxy.mp4"));
      const animated = t.slots.filter((s) => existsSync(join(path, "slots", `slot-${pad(s.slot)}.mp4`))).length;
      appendFileSync(join(path, "logs", "final.log"), `final cut: ${animated} of ${t.slots.length} slots animated, the rest hold their stills\n`);
    },

    async compare(id, path, _o, job) {
      if (!existsSync(join(path, "final", "final.mp4"))) throw new Error("string the cut together first");
      await node(path, job, join(tools, "shot-list.mjs"), ["final/final.mp4", "--out", "compare", "--compare", "analysis/shots.json", "--waivers", "template.json", "--concurrency", "3"], { allowFail: true })
        .then(() => { if (!existsSync(join(path, "compare", "delta.json"))) throw new Error("the comparison did not finish"); });
    },
  };

  // ---------- draft: the brief and the measured format become our template ----------

  const DRAFT_SCHEMA = { type: "object", additionalProperties: false,
    required: ["title", "style", "liveActionStyle", "world", "cast", "setups", "slots", "voice", "voiceGender", "musicPrompt", "textRule", "screen"],
    properties: {
      title: { type: "string" }, style: { type: "string" }, liveActionStyle: { type: "string" }, world: { type: "string" },
      cast: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "design", "role"],
        properties: { id: { type: "string" }, name: { type: "string" }, design: { type: "string" }, role: { type: "string" } } } },
      setups: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "description"], properties: { id: { type: "string" }, description: { type: "string" } } } },
      slots: { type: "array", items: { type: "object", additionalProperties: false, required: ["slot", "prompt", "firstFrame"],
        properties: { slot: { type: "integer" }, prompt: { type: "string" }, firstFrame: { type: "string" } } } },
      voice: { type: "array", items: { type: "object", additionalProperties: false, required: ["phrase", "line"], properties: { phrase: { type: "integer" }, line: { type: "string" } } } },
      voiceGender: { type: "string", enum: ["female", "male"] }, musicPrompt: { type: "string" }, textRule: { type: "string" },
      screen: { type: "object", additionalProperties: false, required: ["appName", "brandColor", "items"], properties: { appName: { type: "string" }, brandColor: { type: "string" },
        items: { type: "array", items: { type: "object", additionalProperties: false, required: ["slot", "product", "button", "doneLabel"],
          properties: { slot: { type: "integer" }, product: { type: "string" }, button: { type: "string" }, doneLabel: { type: "string" } } } } } },
    } };

  async function draftTemplate(base, spec, brief) {
    const FIELDS = ["beat", "shot_size", "angle", "camera_move", "people_count", "extras_count", "hands_in_frame", "medium", "device", "held_prop", "setting",
      "facing", "subject_position", "subject_scale", "expression", "depth_of_field", "characters", "setup", "layout_note", "text_layer", "vo_words"];
    const slots = base.slots.map((s) => ({ slot: s.slot, seconds: s.duration, ...Object.fromEntries(FIELDS.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])) }));
    const phrases = (base.voiceover?.phrases ?? []).map((p) => ({ phrase: p.phrase, seconds: Math.round((p.end - p.start) * 100) / 100, words: p.words, role: p.role, slots: p.slots }));
    const content = spec.split("## 4b.")[1]?.split("## 5.")[0] ?? "";
    const prompt = `You adapt the measured FORMAT of a reference advert into a brand-new advert for our brand. Copy the format exactly; copy none
of its content: no characters, brand, words, sets, props or footage from the reference.

OUR BRIEF
${Object.entries(brief).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

THE FORMAT (measured per shot; every shot of ours must satisfy its shot's fields)
${JSON.stringify(slots)}

RECURRING CHARACTERS (ids and the shots they appear in): ${JSON.stringify(base.continuity?.characters ?? {})}
REPEATED CAMERA SETUPS (ids and the shots that return to them): ${JSON.stringify(base.continuity?.setups ?? {})}
VOICE PHRASES (our line for each must have exactly this many words and play this role): ${JSON.stringify(phrases)}
WHAT THE REFERENCE IS ABOUT (for contrast only; ours must be clearly different):
${content.trim().slice(0, 3000)}

WRITE
- title: a short working title for our advert.
- style: one paragraph describing our visual style for every non-live-action shot (the medium the format uses, our palette). liveActionStyle: the same for live-action shots.
- world: one sentence describing our main location, with no people.
- cast: one entry per recurring character id (C1, C2, ...) and one per other named character our shots need (ids X1, X2, ...): a single
  capitalised first name, a one-sentence visual design (body, skin, hair, clothes, colours, one signature accessory) clearly different from
  everyone else, and their role.
- setups: one entry per repeated setup id: one sentence naming the place, what is in it and where the camera stands. Every shot of a setup
  happens there.
- slots: one entry per shot. prompt: what happens, in one or two sentences, naming our characters by name, at the shot's setup when it has
  one, satisfying the shot's people and extras counts, framing (facing, position, body in frame, shot size), device, prop and setting.
  Hands-only shots say whose hands. A screen close-up shows hands holding a phone with our app (no words). firstFrame: when the prompt
  describes a movement, the opening moment of it as a still; otherwise an empty string.
- voice: our line for every phrase, exactly its word count, in its role. voiceGender: the gender the voice should have.
- musicPrompt: an instrumental music brief at the format's energy (no artist names).
- textRule: one sentence: no readable words anywhere except where the format has on-screen text, and what that text is.
- screen: our app's name, its brand colour, and for each screen close-up shot the product it shows, the button label and the label after tapping.`;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", signal: AbortSignal.timeout(300000),
        headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: draftModel, temperature: 0.7, max_tokens: 12000,
          messages: [{ role: "user", content: lastError ? `${prompt}\n\nYour previous answer had these problems; fix them: ${lastError}` : prompt }],
          response_format: { type: "json_schema", json_schema: { name: "remake_draft", strict: true, schema: DRAFT_SCHEMA } } }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || json.error) throw new Error(`draft model: ${json.error?.message ?? response.status}`);
      const raw = json.choices?.[0]?.message?.content ?? "";
      let draft;
      try { draft = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch { lastError = "the answer was not valid JSON"; continue; }
      const problems = [];
      for (const s of base.slots) if (!draft.slots.some((x) => x.slot === s.slot && x.prompt.trim())) problems.push(`slot ${s.slot} has no prompt`);
      for (const p of base.voiceover?.phrases ?? []) {
        const line = draft.voice.find((v) => v.phrase === p.phrase)?.line ?? "";
        const words = line.replace(/-/g, " ").split(/\s+/).filter(Boolean).length;
        if (Math.abs(words - p.words) > 1) problems.push(`voice phrase ${p.phrase} has ${words} words, needs ${p.words}`);
      }
      for (const id of Object.keys(base.continuity?.characters ?? {})) if (!draft.cast.some((c) => c.id === id)) problems.push(`no cast entry for ${id}`);
      for (const id of Object.keys(base.continuity?.setups ?? {})) if (!draft.setups.some((s) => s.id === id)) problems.push(`no setup entry for ${id}`);
      for (const c of draft.cast) if (!/^[A-Z][a-z]+$/.test(c.name)) problems.push(`cast name "${c.name}" must be one capitalised word`);
      if (!problems.length || attempt === 2) return { ...draft, model: draftModel, problems, cost: json.usage?.cost ?? null };
      lastError = problems.join("; ");
    }
    throw new Error(lastError);
  }

  function buildTemplate(base, draft) {
    const t = structuredClone(base);
    t.castMap = Object.fromEntries(draft.cast.filter((c) => /^C\d+$/.test(c.id)).map((c) => [c.id, c.name]));
    t.setupMap = Object.fromEntries(draft.setups.map((s) => [s.id, s.description]));
    t.styleByMedium = { "live-action": draft.liveActionStyle };
    t.style = draft.style;
    for (const m of new Set(t.slots.map((s) => s.medium))) if (m && m !== "live-action") t.styleByMedium[m] = draft.style;
    t.textRule = draft.textRule;
    const held = t.slots.some((s) => s.device === "held-up" || s.device === "in-background");
    if (draft.screen?.appName && held) t.screenLine = `its screen shows the ${draft.screen.appName} app as in the app-screen reference image`;
    for (const s of t.slots) {
      const d = draft.slots.find((x) => x.slot === s.slot);
      s.prompt = d?.prompt ?? s.prompt ?? "";
      if (d?.firstFrame?.trim()) s.firstFrame = d.firstFrame; else delete s.firstFrame;
      delete s.generate;
    }
    for (const p of t.voiceover?.phrases ?? []) p.line = draft.voice.find((v) => v.phrase === p.phrase)?.line ?? "";
    if (t.voiceover) { t.voiceover.voiceModel = "elevenlabs/eleven-v3"; t.voiceover.voicePreset = draft.voiceGender === "male" ? "brian" : "jessica"; }
    t.keyframes = { margin: 0.5 };
    t.references = [];
    return t;
  }

  // ---------- cast: character sheets, the world, app screens ----------

  /** cast.svml and cast.svrun for a drafted project (the cast step builds them; `hypit check cast.svrun` checks them free). */
  function writeCastSources(id) {
    const path = dir(id), t = readJson(join(path, "template.json"), null), draft = readJson(join(path, "draft.json"), null);
    if (!t || !draft) throw new Error("draft first");
    writeFileSync(join(path, "cast.svml"), castSvml(t, draft));
    const targets = targetsOfSvml(join(path, "cast.svml"));
    writeFileSync(join(path, "cast.svrun"), svrunFor("cast.svml", targets));
    return { t, draft, targets };
  }

  function castSvml(t, draft) {
    const esc = (x) => String(x).replace(/[{}]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const out = ['<?svml using="@hypit/markup@1"?>', "<svml>", '  <import as="text" from="@hypit/text@1"/>', '  <import as="gpt" from="@hypit/gpt-image@1"/>', ""];
    const image = (id, prompt, aspect, refs = []) => out.push(`  <text:Value id="${id}-prompt">`, `    ${esc(prompt)}`, "  </text:Value>",
      `  <gpt:Image id="${id}" prompt={${id}-prompt} aspect-ratio="${aspect}" resolution="1K" background="opaque">`, ...refs.map((r) => `    <gpt:Reference image={${r}.image}/>`), "  </gpt:Image>", "");
    const animated = t.slots.some((s) => s.medium !== "live-action");
    if (animated) {
      for (const c of draft.cast) image(`cast-${slug(c.name)}`, `${draft.style} Character sheet of ${c.name}: ${c.design} Full body, standing straight, facing the camera, arms relaxed, on a plain warm cream backdrop with a soft floor shadow. Only this one character. No text, no letters.`, "2:3");
      image("world", `${draft.style} ${draft.world} No people. No readable words or letters anywhere.`, "16:9");
    }
    for (const s of t.slots.filter((x) => x.device === "screen-closeup")) {
      const item = draft.screen.items.find((i) => i.slot === s.slot) ?? draft.screen.items[0] ?? { product: "today's deal", button: "Get deal", doneLabel: "Got it" };
      const layout = s.layout_note ? ` Layout: ${s.layout_note}` : "";
      image(`screen-${pad(s.slot)}-before`, `A flat, modern phone app screen design, portrait, filling the whole image edge to edge, no phone frame, no hands. App "${draft.screen.appName}" in ${draft.screen.brandColor}: a title bar with the app name at the top, the product name "${item.product}" in large bold type, one big photo of ${item.product}, and one big rounded button that reads "${item.button}".${layout} Very large type, only these few elements, spelled exactly.`, "9:16");
      image(`screen-${pad(s.slot)}-after`, `The same app screen as the reference image, identical in every way except the big button: it is now a darker green and reads "✓ ${item.doneLabel}". Spelled exactly.`, "9:16", [`screen-${pad(s.slot)}-before`]);
    }
    out.push("</svml>", "");
    return out.join("\n");
  }
  const targetsOfSvml = (svml) => [...readFileSync(svml, "utf8").matchAll(/<gpt:Image id="([^"]+)"/g)].map((m) => `${m[1]}.image`);
  const svrunFor = (svml, targets) => ['<?svml using="@hypit/markup/run@1"?>', '<svrun version="1">', `  <author source="./${svml}"/>`, ...targets.map((x) => `  <target output="${x}"/>`), "</svrun>", ""].join("\n");
  const outputFile = (output) => {
    const id = output.replace(/\.image$/, "");
    if (id.startsWith("cast-")) return `cast/${id.slice(5)}.png`;
    if (id === "world") return "cast/world.png";
    return `screens/${id.replace(/^screen-/, "slot-")}.png`;
  };

  function attachCast(t, draft, path) {
    t.references = [];
    for (const c of draft.cast) {
      const file = `./cast/${slug(c.name)}.png`;
      if (existsSync(join(path, file))) t.references.push({ path: file, kind: "cast", personReference: true, role: `is ${c.name}: ${c.design}` });
    }
    if (existsSync(join(path, "cast", "world.png"))) t.references.push({ path: "./cast/world.png", kind: "style", personReference: false, role: `is our world: ${draft.world}` });
    t.screenDesigns = {};
    for (const s of t.slots.filter((x) => x.device === "screen-closeup")) {
      const before = `./screens/slot-${pad(s.slot)}-before.png`, after = `./screens/slot-${pad(s.slot)}-after.png`;
      if (existsSync(join(path, before))) t.screenDesigns[s.slot] = { before, after: existsSync(join(path, after)) ? after : before, buttonAt: 75 };
    }
    const firstScreen = Object.values(t.screenDesigns)[0];
    if (firstScreen && t.screenLine) t.references.push({ path: firstScreen.before, kind: "screen", personReference: false, role: `is the ${draft.screen.appName} app screen every phone shows` });
    return t;
  }

  /** Three frames per reference shot and a small playback copy of the reference (after analyze, or an imported analysis). */
  function prepareAnalysis(id) {
    const path = dir(id), p = load(id), ref = join(path, p.reference.file);
    const shots = readJson(join(path, "analysis", "shots.json"), { shots: [] }).shots;
    mkdirSync(join(path, "analysis", "thumbs"), { recursive: true });
    for (const s of shots) {
      [0.15, 0.5, 0.85].forEach((f, k) => ffmpeg(["-ss", (s.start + f * s.duration).toFixed(3), "-i", ref, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4",
        join(path, "analysis", "thumbs", `shot-${String(s.shot).padStart(3, "0")}-${k + 1}.jpg`)]));
    }
    proxy(ref, join(path, "reference", "proxy.mp4"));
  }

  // ---------- media helpers ----------

  function ffmpeg(list) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...list], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ffmpeg: ${String(r.stderr).trim().split("\n").slice(-2).join(" ")}`);
  }
  function proxy(src, out) {
    ffmpeg(["-i", src, "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out]);
  }
  function probeVideo(path) {
    const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate:format=duration", "-of", "json", path], { encoding: "utf8" });
    let j = {};
    try { j = JSON.parse(r.stdout); } catch { /* not a video ffprobe can read */ }
    const s = j.streams?.[0] ?? {};
    const [a, b] = String(s.r_frame_rate ?? "0/1").split("/").map(Number);
    return { width: s.width ?? null, height: s.height ?? null, fps: b ? Math.round((a / b) * 1000) / 1000 : null, duration: Number(j.format?.duration ?? 0) || null };
  }
  /** A cached JPEG thumbnail of any project image (or a video frame), for the app's grids. */
  function thumb(id, rel, width = 480) {
    const src = file(id, rel);
    if (!existsSync(src)) throw new Error("not found");
    const w = Math.max(64, Math.min(1280, Number(width) || 480));
    const out = join(dir(id), ".thumbs", `${rel.replace(/[\\/]/g, "_")}-${w}.jpg`);
    if (!existsSync(out) || statSync(out).mtimeMs < statSync(src).mtimeMs) {
      mkdirSync(dirname(out), { recursive: true });
      ffmpeg(["-i", src, "-frames:v", "1", "-vf", `scale=${w}:-2`, "-q:v", "4", out]);
    }
    return out;
  }
  function tail(path, lines) {
    try { return readFileSync(path, "utf8").split("\n").filter((l) => !/UNDICI|trace-warnings|ExperimentalWarning/.test(l)).slice(-lines).join("\n"); } catch { return ""; }
  }

  // Steps left running when the server stopped are marked interrupted.
  for (const id of readdirSync(root)) {
    const path = join(root, id, "project.json");
    if (!existsSync(path)) continue;
    const p = readJson(path, null);
    let changed = false;
    for (const s of Object.values(p?.steps ?? {})) if (s.state === "running") { s.state = "interrupted"; changed = true; }
    if (changed) writeJson(path, p);
  }

  return { root, STEPS, CHAINS, RATES, list, get, create, prepareAnalysis, writeCastSources, setBrief, editSlot, editLine, setDecisions, estimate, run, stop, file, thumb,
    log: (id, step, lines = 200) => tail(join(dir(id), "logs", `${step}.log`), lines) };
}
