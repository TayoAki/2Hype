#!/usr/bin/env node
// Lock every shot of a remake to the reference before any video is paid for. Text prompts cannot hold a set, a
// framing or a head count across shots, so each shot is made as a still first and checked; video only animates it.
//
//   node tools/keyframes.mjs plates  <template.json> --out <dir>    one empty-set still per camera setup the reference repeats
//   node tools/keyframes.mjs stills  <template.json> --out <dir> [--only 12,13]
//                                                                    each shot's opening still, built on its setup's plate
//                                                                    (screen close-ups also get a last frame: finger on the button)
//   node tools/keyframes.mjs screens <template.json> --stills <dir> [--python python3]
//                                                                    lays the designed app screens on the close-up stills
//   node tools/keyframes.mjs check   <template.json> --stills <dir> [--model google/gemini-2.5-flash]
//                                                                    labels every still and checks it against its reference slot
//   node tools/keyframes.mjs frames  <template.json> --stills <dir> --out <dir> [--decisions decisions.json]
//                                                                    one first-frame Seedance clip per shot, plus clips-plan.json
//
// Build each .svrun with hypit and fetch the outputs into the stills folder as plate-S1.png, slot-01.png and
// slot-02-last.png (the names are the SVML ids). Review between steps with tools/review.mjs; check exits 2 while
// any shot misses a critical variable that is not waived.
//
// Template fields read here, beside the usual template@2 ones: references[].kind ("set", "cast", "screen" or "style";
// plates use set and style images, stills add the cast and, for held-up phones, the screen), screenDesigns
// ({ "<slot>": { before, after, button: "x0,y0,x1,y1" or buttonAt: <% down> } }, paths from the template's folder), setupReferences ({ "S1": ["wall", ...] }:
// the set and style images, by file name, that go with each setup's plate; all of them otherwise), slot.firstFrame (the moment the
// opening still shows, when the prompt describes a movement), slot.waive ({ field: reason } for a deliberate
// difference from the reference) and keyframes.margin (seconds of spare clip, default 0.5).
// Nothing from the reference is ever a generation input: plates and stills are described in words; the reference
// frames are only looked at by the checker, through the labels in template.json.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { HOLD_GUIDE, LABELS, OPENROUTER, PHRASE_ROLES, SCHEMA, TEXT_KINDS, holdLineFor, postOpenRouter, round, svmlText } from "./shot-list.mjs";

const [command, templateArg, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const COMMANDS = ["plates", "stills", "screens", "check", "frames"];
if (!COMMANDS.includes(command) || !templateArg) {
  console.error(`Usage: node tools/keyframes.mjs <${COMMANDS.join("|")}> <template.json> [--out <dir>] [--stills <dir>] [--decisions <json>] [--model <id>] [--python <bin>]`);
  process.exit(command === "-h" || command === "--help" ? 0 : 1);
}
const templatePath = resolve(templateArg);
const base = dirname(templatePath);
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const pad = (n) => String(n).padStart(2, "0");
const only = opt("--only") ? opt("--only").split(",").map(Number) : null;  // regenerate or re-check just these slots
const slots = template.slots.filter((s) => s.generate !== false && (!only || only.includes(s.slot)));
const castMap = template.castMap ?? {}, setupMap = template.setupMap ?? {};
const references = (template.references ?? []).map((r) => ({ ...r, kind: r.kind ?? (r.personReference ? "cast" : "set"), abs: resolve(base, r.path) }));
const styleOf = (s) => svmlText(template.styleByMedium?.[s.medium] ?? template.style ?? "");
const textRule = svmlText(template.textRule ?? "No readable words or letters anywhere.");
const margin = template.keyframes?.margin ?? 0.5;
const stillsDir = opt("--stills") ? resolve(opt("--stills")) : null;
const stillPath = (name) => (stillsDir && existsSync(join(stillsDir, `${name}.png`)) ? join(stillsDir, `${name}.png`) : null);
const punctuate = (text) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

// Setups the reference repeats, plus the slots that borrow a setup's location for a closer angle (groupWith).
const setups = {};
for (const [id, list] of Object.entries(template.continuity?.setups ?? {})) if (setupMap[id]) setups[id] = { slots: [...list], closer: [] };
for (const s of template.slots) if (s.groupWith && setups[s.groupWith] && !setups[s.groupWith].slots.includes(s.slot)) setups[s.groupWith].closer.push(s.slot);
const setupOf = (s) => (s.setup && setups[s.setup]?.slots.includes(s.slot) ? s.setup : s.groupWith && setups[s.groupWith] ? s.groupWith : null);
const majority = (values) => { const c = new Map(); for (const v of values) c.set(v, (c.get(v) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]; };

function writeRun(out, name, ids, svml) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${name}.svml`), svml.join("\n") + "\n");
  writeFileSync(join(out, `${name}.svrun`), ['<?svml using="@hypit/markup/run@1"?>', '<svrun version="1">', `  <author source="./${name}.svml"/>`,
    ...ids.map((id) => `  <target output="${id}"/>`), "</svrun>", ""].join("\n"));
}
const header = (imports) => ['<?svml using="@hypit/markup@1"?>', "<svml>", '  <import as="text" from="@hypit/text@1"/>', '  <import as="asset" from="@hypit/media@1"/>',
  ...imports, ""];
const assetLine = (id, abs, out) => `  <asset:Image id="${id}" src="./${relative(out, abs).split("\\").join("/")}"/>`;

/** Our characters in a slot: castMap names for its character ids, plus any cast-sheet name its prompt mentions. */
function castNames(s) {
  const named = [s.characters ?? []].flat().map((c) => castMap[c.replace(/^hands:/, "")]).filter(Boolean);
  const sheets = references.filter((r) => r.kind === "cast");
  const inPrompt = (s.prompt.match(/\b[A-Z][a-z]+\b/g) ?? []).filter((n) => sheets.some((r) => new RegExp(`^(is|shows) ${n}\\b|\\b${n}\\b`).test(r.role ?? "")));
  return [...new Set([...named, ...inPrompt])];
}
const sheetsFor = (names) => references.filter((r) => r.kind === "cast" && names.some((n) => new RegExp(`\\b${n}\\b`).test(r.role ?? "")));

// ---------- plates ----------

function plates() {
  const out = resolve(opt("--out", "."));
  const setRefs = references.filter((r) => r.kind === "set" || r.kind === "style");
  const svml = header(['  <import as="gpt" from="@hypit/gpt-image@1"/>']);
  svml.push("  <!-- One empty set per camera setup the reference returns to: every shot of that setup is built on it, so the",
    "       location, props, light and camera position cannot drift between shots. Generated by tools/keyframes.mjs. -->");
  setRefs.forEach((r, i) => svml.push(assetLine(`ref-${i + 1}`, r.abs, out)));
  const ids = [];
  const stem = (r) => r.abs.split(/[\\/]/).pop().replace(/\.[^.]+$/, "");
  for (const [id, setup] of Object.entries(setups)) {
    const wanted = template.setupReferences?.[id];
    const refs = setRefs.map((r, i) => ({ ...r, asset: `ref-${i + 1}` })).filter((r) => !wanted || wanted.includes(stem(r)));
    const shots = setup.slots.map((n) => template.slots.find((s) => s.slot === n));
    const size = majority(shots.map((s) => s.shot_size)), angle = majority(shots.map((s) => s.angle));
    const people = Math.max(...shots.map((s) => s.people_count ?? 0));
    const position = majority(shots.filter((s) => s.subject_position && s.subject_position !== "none").map((s) => s.subject_position)) ?? "center";
    const shallow = shots.filter((s) => s.depth_of_field === "shallow").length * 2 > shots.length;
    const lines = [styleOf(shots[0]) && punctuate(styleOf(shots[0])),
      `An empty set, nobody in it: ${punctuate(svmlText(setupMap[id]))}`,
      `Camera: ${size} shot, ${angle} angle, as a locked-off film camera would frame this set for a scene${people ? `, leaving clear floor space at the ${position} of the frame where ${people === 1 ? "one character" : `${people} characters`} will stand later` : ""}.`,
      shallow ? "Shallow depth of field: the far background is softly blurred." : "Deep focus: the whole set is sharp.",
      refs.length ? `${refs.map((r, i) => `Reference image ${i + 1} ${svmlText(r.role ?? "is a style reference")}`).join("; ")}; keep their style.` : "",
      "No people, no animals. No readable words or letters anywhere except shapes on signs."].filter(Boolean);
    svml.push("", `  <!-- Setup ${id}: slots ${setup.slots.join(", ")}${setup.closer.length ? `; closer angles ${setup.closer.join(", ")}` : ""} -->`,
      `  <text:Value id="plate-${id}-prompt">`, ...lines.map((l) => `    ${l}`), "  </text:Value>",
      `  <gpt:Image id="plate-${id}" prompt={plate-${id}-prompt} aspect-ratio="16:9" resolution="1K" background="opaque">`,
      ...refs.map((r) => `    <gpt:Reference image={${r.asset}}/>`), "  </gpt:Image>");
    ids.push(`plate-${id}.image`);
  }
  svml.push("</svml>");
  writeRun(out, "plates", ids, svml);
  console.log(`Wrote ${out}/plates.svml and plates.svrun: ${ids.length} plate(s) (${Object.entries(setups).map(([id, s]) => `${id}: slots ${[...s.slots, ...s.closer].join(", ")}`).join("; ")}).`);
  console.log("Build it, fetch each plate-<setup>.image to <stills>/plate-<setup>.png, look at them, then run: keyframes.mjs stills");
}

// ---------- stills ----------

function stills() {
  const out = resolve(opt("--out", "."));
  const plateDir = stillsDir ?? out;
  const svml = header(['  <import as="gpt" from="@hypit/gpt-image@1"/>']);
  svml.push("  <!-- Each shot's opening still, on its setup's plate, with the reference slot's head count, framing, facing,",
    "       props and focus. Screen close-ups get a plain white screen (the design is laid on with keyframes.mjs screens)",
    "       and a last frame with the fingertip on the button. Generated by tools/keyframes.mjs. -->");
  const assets = new Map();
  const asset = (abs) => { if (!assets.has(abs)) { assets.set(abs, `ref-${assets.size + 1}`); svml.push(assetLine(assets.get(abs), abs, out)); } return assets.get(abs); };
  const whiteScreen = { ...template, screenLine: "its screen is plain and evenly glowing white, with no icons, text or reflections, ready for the app design" };
  const ids = [], missing = [];
  for (const s of slots) {
    const id = `slot-${pad(s.slot)}`;
    const setup = setupOf(s);
    const plate = setup ? join(plateDir, `plate-${setup}.png`) : null;
    if (plate && !existsSync(plate)) missing.push(`plate-${setup}.png`);
    const closeup = s.device === "screen-closeup";
    const people = (s.people_count ?? 0) > 0 || s.hands_in_frame;
    const refs = [];
    if (plate) refs.push({ abs: plate, role: setups[setup].closer.includes(s.slot)
      ? "is the set for this shot, seen wider: this shot is a closer angle in the same place, with the same props and light"
      : "is the empty set for this shot: keep its background, props, lighting and camera position exactly and place the characters into it" });
    // Only the character sheets for who is in this shot (named in castMap for its characters, or in its prompt);
    // one character per sheet, or the generator picks the wrong person off a lineup.
    const sheets = sheetsFor(castNames(s));
    // Character sheets are drawings of our cast: never for live action, all of them only when the slot names characters.
    const animated = s.medium !== "live-action";
    if (people && animated) for (const r of sheets.length ? sheets : (s.characters ?? []).some((c) => /^C\d+$/.test(c)) ? references.filter((x) => x.kind === "cast") : []) refs.push(r);
    // A set or style image would pull its location into a close-up of hands on a plain background: only for scenes.
    if (!plate && animated && !closeup) for (const r of references.filter((x) => x.kind === "style" || (x.kind === "set" && !s.setup))) refs.push(r);
    if (["held-up", "in-background"].includes(s.device)) for (const r of references.filter((x) => x.kind === "screen")) refs.push(r);
    const hold = holdLineFor(closeup ? whiteScreen : template)(s);
    const lines = [styleOf(s) && punctuate(styleOf(s)),
      `The opening frame of one shot of a video: ${punctuate(svmlText(s.firstFrame ?? s.prompt))}`,
      hold,
      `Camera: ${s.shot_size} shot, ${s.angle} angle.`,
      refs.length ? `${refs.map((r, i) => `Reference image ${i + 1} ${svmlText(r.role ?? "is a reference")}`).join("; ")}.` : "",
      closeup ? "The phone is a realistic slim modern smartphone: thin bezels, rounded corners, no home button. The whole screen is visible." : "",
      // A close-up's screen stays plain white here: the exact app design is laid on afterwards (keyframes.mjs screens).
      closeup ? "No readable words or letters anywhere; the phone screen is plain white." : textRule].filter(Boolean);
    svml.push("", `  <!-- Slot ${s.slot}${setup ? ` (setup ${setup})` : ""} -->`, `  <text:Value id="${id}-prompt">`, ...lines.map((l) => `    ${l}`), "  </text:Value>",
      `  <gpt:Image id="${id}" prompt={${id}-prompt} aspect-ratio="16:9" resolution="1K" background="opaque">`,
      ...refs.map((r) => `    <gpt:Reference image={${asset(r.abs)}}/>`), "  </gpt:Image>");
    ids.push(`${id}.image`);
    const design = template.screenDesigns?.[s.slot];
    if (closeup && design) {
      // Where the button sits on the screen: from its box in the design, else the design's buttonAt (% down).
      const [, y0, , y1] = String(design.button ?? "").split(",").map(Number);
      const down = design.button ? Math.round((100 * (y0 + y1)) / 2 / Number(design.height ?? 1950)) : Math.round(design.buttonAt ?? 75);
      svml.push(`  <text:Value id="${id}-last-prompt">`,
        `    The same shot as the reference image: the same phone in the same place and angle, the same hands, the same light`,
        `    and background, the same style. One change only: the index fingertip now presses the screen at its horizontal`,
        `    centre, about ${down}% of the way down from the top of the screen, touching the glass. The rest of the screen stays`,
        "    plain, evenly glowing white with no icons or text. No text, no letters, no logos anywhere.", "  </text:Value>",
        `  <gpt:Image id="${id}-last" prompt={${id}-last-prompt} aspect-ratio="16:9" resolution="1K" background="opaque">`,
        `    <gpt:Reference image={${id}.image}/>`, "  </gpt:Image>");
      ids.push(`${id}-last.image`);
    }
  }
  svml.push("</svml>");
  writeRun(out, "stills", ids, svml);
  if (missing.length) console.warn(`Missing plates (build plates first): ${[...new Set(missing)].join(", ")}`);
  console.log(`Wrote ${out}/stills.svml and stills.svrun: ${ids.length} still(s) for ${slots.length} shots.`);
  console.log("Build it, fetch each <id>.image to <stills>/<id>.png, then run: keyframes.mjs screens (if any close-ups), then keyframes.mjs check");
}

// ---------- screens ----------

function screens() {
  const python = opt("--python", process.env.PYTHON ?? "python3");
  const tool = join(dirname(new URL(import.meta.url).pathname), "key-screen.py");
  for (const [n, d] of Object.entries(template.screenDesigns ?? {})) {
    const id = `slot-${pad(n)}`, first = stillPath(id), last = stillPath(`${id}-last`);
    if (!first) { console.warn(`slot ${n}: no ${id}.png yet`); continue; }
    const before = resolve(base, d.before), after = resolve(base, d.after ?? d.before);
    const go = (list) => { const r = spawnSync(python, [tool, ...list], { encoding: "utf8" }); if (r.status !== 0) throw new Error(`key-screen.py: ${r.stderr.slice(-300)}`); return r.stdout.trim(); };
    console.log(go([first, before, after, join(stillsDir, `${id}-ui.png`), "--mode", "still"]));
    // The last frame shows the screen after the tap, so the generator animates the change itself.
    if (last) console.log(go([last, after, after, join(stillsDir, `${id}-last-ui.png`), "--mode", "still", "--ref", join(stillsDir, `${id}-ui.png`)]));
  }
}

// ---------- check ----------

const STILL_FIELDS = ["people_count", "extras_count", "hands_in_frame", "medium", "device", "held_prop", "setting", "shot_size", "angle",
  "facing", "subject_position", "subject_scale", "depth_of_field", "expression"];
const SOFT = new Set(["expression", "depth_of_field"]);  // look choices: reported, never blocking
const STILL_SCHEMA = { ...SCHEMA, required: SCHEMA.required.filter((k) => k !== "camera_move" && k !== "beat") };
STILL_SCHEMA.properties = Object.fromEntries(Object.entries(SCHEMA.properties).filter(([k]) => STILL_SCHEMA.required.includes(k)));

async function labelStill(file, s, model) {
  const text = `You label the visual grammar of one still frame: the opening frame of shot ${s.slot} of a short advert, for an editor's
format check. ${HOLD_GUIDE}
Return only the labels. Do not transcribe words or name brands.`;
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(file).toString("base64")}` } }] }],
    response_format: { type: "json_schema", json_schema: { name: "still_labels", strict: true, schema: STILL_SCHEMA } } });
  const raw = json.choices?.[0]?.message?.content ?? "";
  const labels = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  for (const [k, allowed] of Object.entries(LABELS)) if (k in labels && !allowed.includes(labels[k])) throw new Error(`model returned ${k}=${labels[k]}`);
  if (labels.text_kinds?.some((k) => !TEXT_KINDS.includes(k))) throw new Error("bad text_kinds");
  if (labels.device === "held-up" && labels.hands_in_frame && labels.people_count === 0) labels.device = "screen-closeup";
  return { labels, cost: json.usage?.cost ?? 0 };
}

function same(field, want, got, s) {
  if (got === undefined) return false;
  if (field === "medium") return want === got || (["3d-animation", "stop-motion"].includes(want) && ["3d-animation", "stop-motion"].includes(got));
  if (field === "extras_count") return Math.abs(want - got) <= Math.max(2, want * 0.5);
  if (["facing", "subject_position", "subject_scale", "expression"].includes(field) && s.people_count === 0) return true;
  return want === got;
}

async function ask(model, content, schema, name) {
  const json = await postOpenRouter(OPENROUTER, { model, temperature: 0, messages: [{ role: "user", content }],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } } });
  const raw = json.choices?.[0]?.message?.content ?? "";
  return { result: JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)), cost: json.usage?.cost ?? 0 };
}
const image = (file) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${readFileSync(file).toString("base64")}` } });

async function check() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("check needs OPENROUTER_API_KEY");
  const model = opt("--model", "google/gemini-2.5-flash"), fallback = "openai/gpt-4.1-mini";
  const report = { format: "keyframes.check@1", template: templatePath, model, slots: {}, setups: {}, lines: [], screens: {}, cost: 0 };
  const label = async (file, s) => {
    for (const m of [model, fallback]) { try { const r = await label1(file, s, m); return r; } catch (error) { console.error(`  slot ${s.slot} (${m}): ${error.message}`); } }
    return null;
  };
  const label1 = async (file, s, m) => { const r = await labelStill(file, s, m); report.cost += r.cost; return r.labels; };
  let next = 0;
  const worker = async () => {
    while (next < slots.length) {
      const s = slots[next++];
      const file = stillPath(`slot-${pad(s.slot)}-ui`) ?? stillPath(`slot-${pad(s.slot)}`);
      if (!file) { report.slots[s.slot] = { pass: false, missing: true, misses: [{ field: "still", want: "present", got: "missing" }] }; continue; }
      // Two labelling passes; a third breaks a tie on any compared field.
      const runs = [await label(file, s), await label(file, s)].filter(Boolean);
      const differ = runs.length === 2 && STILL_FIELDS.some((f) => JSON.stringify(runs[0][f]) !== JSON.stringify(runs[1][f]));
      if (differ) { const third = await label(file, s); if (third) runs.push(third); }
      if (!runs.length) { report.slots[s.slot] = { pass: false, misses: [{ field: "labels", want: "labelled", got: "failed" }] }; continue; }
      const labels = Object.fromEntries(STILL_FIELDS.map((f) => [f, typeof runs[0][f] === "number" ? [...runs.map((r) => r[f])].sort((a, b) => a - b)[Math.floor((runs.length - 1) / 2)] : majority(runs.map((r) => JSON.stringify(r[f]))) && JSON.parse(majority(runs.map((r) => JSON.stringify(r[f]))))]));
      const misses = [];
      for (const f of STILL_FIELDS) {
        if (s[f] === undefined || same(f, s[f], labels[f], s)) continue;
        misses.push({ field: f, want: s[f], got: labels[f], critical: !SOFT.has(f), ...(s.waive?.[f] ? { waived: s.waive[f] } : {}) });
      }
      report.slots[s.slot] = { file: relative(base, file), labels, misses, pass: !misses.some((m) => m.critical && !m.waived) };
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));

  // Cast: every named character is in the still and looks like their sheet; nobody else is featured.
  const CAST_SCHEMA = { type: "object", additionalProperties: false, required: ["characters", "others"], properties: {
    characters: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "present", "matches_design", "prominence", "note"],
      properties: { name: { type: "string" }, present: { type: "boolean" }, matches_design: { type: "boolean" },
        prominence: { type: "string", enum: ["main", "secondary", "background", "absent"] }, note: { type: "string" } } } },
    others: { type: "integer" } } };
  for (const s of slots) {
    const entry = report.slots[s.slot];
    const names = castNames(s), sheets = sheetsFor(names);
    if (!entry?.file || !(s.people_count > 0) || !names.length || !sheets.length) continue;
    const content = [{ type: "text", text: `Image 1 is a still from an advert. The other images are character sheets for ${names.join(", ")}.
For each named character, say whether they appear in the still (present), whether hair, skin, face, clothes and
accessories match their sheet, judging only what this angle shows (a character seen from behind is on model when their
hair, build and clothes match) (matches_design), and how prominent they are (main: a subject of the shot; secondary;
background: small or far behind). others: how many other people in the still are as prominent as a main or secondary
character and are none of these. note: what differs, at most 12 words, or an empty string.` }, image(resolve(base, entry.file))];
    for (const r of sheets) content.push({ type: "text", text: `Sheet: ${svmlText(r.role ?? "")}` }, image(r.abs));
    try {
      const { result, cost } = await ask(model, content, CAST_SCHEMA, "cast_check");
      report.cost += cost;
      // A named character is featured: present, on model, and not lost in the background.
      entry.cast = result.characters.filter((c) => names.includes(c.name)).map((c) => ({ ...c, ok: c.present && c.matches_design && ["main", "secondary"].includes(c.prominence),
        ...(c.present && !["main", "secondary"].includes(c.prominence) ? { note: c.note || "only in the background" } : {}) }));
      for (const n of names) if (!entry.cast.some((c) => c.name === n)) entry.cast.push({ name: n, present: false, matches_design: false, prominence: "absent", note: "not reported", ok: false });
      // Others as prominent as the cast: allowed up to the featured people the slot has beyond its named characters,
      // plus the background people it asks for (a checker often counts a nearby extra as featured).
      entry.castOthers = Math.max(0, result.others - Math.max(0, (s.people_count ?? 0) - names.length) - (s.extras_count ?? 0));
      const castOk = entry.cast.every((c) => c.ok) && entry.castOthers === 0;
      if (!castOk && !s.waive?.cast) entry.pass = false;
    } catch (error) { console.error(`  cast ${s.slot}: ${error.message}`); }
  }

  // Setups: the model compares every still of a setup with its plate (same place, same camera position).
  const SETUP_SCHEMA = { type: "object", additionalProperties: false, required: ["shots"], properties: { shots: { type: "array", items: { type: "object",
    additionalProperties: false, required: ["slot", "same_place", "same_camera", "note"], properties: { slot: { type: "integer" }, same_place: { type: "boolean" },
      same_camera: { type: "boolean" }, note: { type: "string" } } } } } };
  for (const [id, setup] of Object.entries(setups)) {
    const plate = stillPath(`plate-${id}`);
    const members = [...setup.slots, ...setup.closer].map((n) => ({ n, file: stillPath(`slot-${pad(n)}-ui`) ?? stillPath(`slot-${pad(n)}`) })).filter((x) => x.file);
    if (!plate || !members.length) continue;
    const content = [{ type: "text", text: `Image 1 is an empty film set. For each following still, say whether it shows the same place (same
background, props and layout) and whether it is shot from the same camera position and angle${setup.closer.length ? ` (slots ${setup.closer.join(", ")} are meant to be a closer angle in the same place: judge only the place for them)` : ""}. People added to the set do not matter. note: what differs, in at most 15 words, or an empty string.` }, image(plate)];
    for (const m of members) content.push({ type: "text", text: `Slot ${m.n}:` }, image(m.file));
    try {
      const { result, cost } = await ask(model, content, SETUP_SCHEMA, "setup_check");
      report.cost += cost;
      report.setups[id] = result.shots;
      for (const r of result.shots) {
        const entry = report.slots[r.slot];
        if (!entry) continue;
        const closer = setup.closer.includes(r.slot);
        const ok = r.same_place && (closer || r.same_camera);
        entry.setup = { plate: id, same: ok, note: r.note };
        if (!ok && !template.slots.find((s) => s.slot === r.slot)?.waive?.setup) entry.pass = false;
      }
    } catch (error) { console.error(`  setup ${id}: ${error.message}`); }
  }

  // Voice lines: each of our lines must do the job its reference phrase does (role), at the same length.
  const phrases = (template.voiceover?.phrases ?? []).filter((p) => p.line);
  if (phrases.length) {
    const LINE_SCHEMA = { type: "object", additionalProperties: false, required: ["phrases"], properties: { phrases: { type: "array", items: { type: "object",
      additionalProperties: false, required: ["phrase", "role"], properties: { phrase: { type: "integer" }, role: { type: "string", enum: PHRASE_ROLES } } } } } };
    try {
      // Three passes vote per line: one pass flips between neighbouring roles from run to run.
      const passes = [];
      for (let i = 0; i < 3; i++) {
        const { result, cost } = await ask(model, [{ type: "text", text: `These are the voiceover lines of an advert, in order; the last one is spoken over the end card with the logo. Give each line's role in the advert.\n${phrases.map((p) => `${p.phrase}: ${p.line}`).join("\n")}` }], LINE_SCHEMA, "line_roles");
        report.cost += cost;
        passes.push(result.phrases);
      }
      for (const p of phrases) {
        const got = majority(passes.map((list) => list.find((x) => x.phrase === p.phrase)?.role).filter(Boolean));
        const words = p.line.replace(/-/g, " ").split(/\s+/).filter(Boolean).length;
        report.lines.push({ phrase: p.phrase, want: p.role, got, words, wantWords: p.words, pass: (!p.role || got === p.role) && Math.abs(words - p.words) <= 1 });
      }
    } catch (error) { console.error(`  voice lines: ${error.message}`); }
  }

  // Screen designs against the reference slot's layout (zones, element count, relative sizes).
  const SCREEN_SCHEMA = { type: "object", additionalProperties: false, required: ["matches", "differences"], properties: { matches: { type: "boolean" }, differences: { type: "string" } } };
  for (const [n, d] of Object.entries(template.screenDesigns ?? {})) {
    const note = template.slots.find((s) => s.slot === Number(n))?.layout_note;
    if (!note) continue;
    try {
      const { result, cost } = await ask(model, [{ type: "text", text: `This is a phone screen design on its own. A reference shot was described as: "${note}". Judge only the screen's own layout against the part of that description about what the screen shows (its zones, how many main elements there are and their relative sizes); ignore hands, the frame around the phone, overlays, words and colours. differences: what to change on the screen, at most 25 words, or an empty string.` }, image(resolve(base, d.before))], SCREEN_SCHEMA, "screen_layout");
      report.cost += cost;
      report.screens[n] = result;
    } catch (error) { console.error(`  screen ${n}: ${error.message}`); }
  }

  report.cost = round(report.cost);
  const failing = Object.entries(report.slots).filter(([, r]) => !r.pass).map(([n]) => Number(n));
  const out = join(stillsDir, "check.json");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const md = ["# Stills check", "", `${slots.length - failing.length} of ${slots.length} shots pass${failing.length ? `; failing: ${failing.join(", ")}` : ""}. Labelled with ${model} for $${report.cost.toFixed(3)}.`, "",
    "| Shot | Result | Misses (ours, want) | Cast | Set |", "|---|---|---|---|---|",
    ...slots.map((s) => { const r = report.slots[s.slot] ?? {}; return `| ${s.slot} | ${r.pass ? "pass" : "FAIL"} | ${(r.misses ?? []).map((m) => `${m.field}: ${m.got} (want ${m.want})${m.waived ? ` [waived: ${m.waived}]` : m.critical === false ? " [soft]" : ""}`).join("; ") || "-"} | ${r.cast ? r.cast.map((c) => `${c.name} ${c.ok ? "ok" : c.present ? `looks wrong${c.note ? ` (${c.note})` : ""}` : "MISSING"}`).join("; ") + (r.castOthers ? `; +${r.castOthers} other` : "") : "-"} | ${r.setup ? `${r.setup.same ? "same" : "DIFFERS"} as plate ${r.setup.plate}${r.setup.note ? `: ${r.setup.note}` : ""}` : "-"} |`; }),
    ...(report.lines.length ? ["", "## Voice lines", "| Phrase | Role (ours, want) | Words (ours, want) | Result |", "|---|---|---|---|",
      ...report.lines.map((l) => `| ${l.phrase} | ${l.got} (${l.want ?? "-"}) | ${l.words} (${l.wantWords}) | ${l.pass ? "pass" : "FAIL"} |`)] : []),
    ...(Object.keys(report.screens).length ? ["", "## Screen layouts", ...Object.entries(report.screens).map(([n, r]) => `- Slot ${n}: ${r.matches ? "matches" : "differs"}${r.differences ? `: ${r.differences}` : ""}`)] : []), ""];
  writeFileSync(join(stillsDir, "STILLS-CHECK.md"), md.join("\n"));
  console.log(`Stills: ${slots.length - failing.length} of ${slots.length} pass${failing.length ? ` (failing ${failing.join(", ")})` : ""}; voice lines ${report.lines.filter((l) => l.pass).length} of ${report.lines.length}; checks cost $${report.cost.toFixed(3)}. See ${stillsDir}/STILLS-CHECK.md`);
  if (failing.length || report.lines.some((l) => !l.pass)) process.exitCode = 2;
}

// ---------- frames ----------

function energy(motion) {
  if (motion === undefined) return "natural movement";
  if (motion < 1.5) return "almost still: only small, natural movement";
  if (motion < 5) return "gentle, easy movement";
  if (motion < 10) return "lively movement";
  if (motion < 20) return "energetic, fast movement with big gestures";
  return "very fast, explosive movement";
}
const MOVES = { static: "locked-off static camera", handheld: "light handheld camera", pan: "the camera pans", tilt: "the camera tilts", "push-in": "the camera pushes in slowly",
  "pull-out": "the camera pulls out slowly", tracking: "the camera tracks alongside", orbit: "the camera orbits a little around the subject", zoom: "a slow zoom", unclear: "steady camera" };
const MODELS = { "mini-720p": ["mini", "720p"], "fast-720p": ["fast", "720p"], "standard-720p": ["standard", "720p"], "standard-1080p": ["standard", "1080p"] };

function frames() {
  const out = resolve(opt("--out", "."));
  const decisions = opt("--decisions") ? JSON.parse(readFileSync(resolve(opt("--decisions")), "utf8")).decisions ?? {} : {};
  const fallback = `${template.seedance?.model ?? "mini"}-${template.seedance?.resolution ?? "720p"}`;
  const svml = header(['  <import as="seedance" from="@hypit/seedance@1"/>']);
  svml.push("  <!-- One clip per shot, animated from its checked opening still (and, for screen close-ups, to its last frame).",
    "       Generated by tools/keyframes.mjs; tools/assemble.mjs cuts each slot from the start of its clip. -->");
  const plan = { format: "shot-list.clips-plan@1", template: templatePath, timelineFps: template.timelineFps ?? 24, margin, clips: [] };
  const ids = [], skipped = [];
  let seconds = 0, cost = 0;
  const RATE = { mini: 3.5e-6, fast: 4.2e-6, standard: 7.0e-6 }, PIXELS = { "720p": 1280 * 720, "1080p": 1920 * 1080 };
  for (const s of slots) {
    const choice = decisions[s.slot]?.model ?? fallback;
    if (choice === "skip") { skipped.push(s.slot); continue; }
    const [variant, resolution] = MODELS[choice] ?? MODELS[fallback];
    const id = `slot-${pad(s.slot)}`;
    const first = stillPath(`${id}-ui`) ?? stillPath(id);
    if (!first) throw new Error(`no opening still for slot ${s.slot} in ${stillsDir}`);
    const last = stillPath(`${id}-last-ui`) ?? stillPath(`${id}-last`);
    const clip = Math.min(15, Math.max(4, Math.ceil(s.duration + margin)));
    const person = (s.people_count ?? 0) > 0;
    const note = decisions[s.slot]?.note;
    const lines = [styleOf(s) && punctuate(styleOf(s)),
      `One continuous ${clip}-second shot with no cuts, starting exactly on the first frame: ${punctuate(svmlText(s.prompt))}`,
      `Movement: ${energy(s.motion)}. Camera: ${MOVES[s.camera_move] ?? "steady camera"}.`,
      `Keep the set, the characters, how many there are, their clothes, the framing and the light exactly as in the first frame; nobody new enters${last ? "; end exactly on the last frame" : ""}.`,
      note ? `Director's note: ${punctuate(svmlText(note))}` : "",
      textRule].filter(Boolean);
    svml.push(assetLine(`${id}-first`, first, out), ...(last ? [assetLine(`${id}-last`, last, out)] : []),
      `  <text:Value id="${id}-prompt">`, ...lines.map((l) => `    ${l}`), "  </text:Value>",
      `  <seedance:FrameVideo id="${id}" model="${variant}" prompt={${id}-prompt} duration="${clip}" resolution="${resolution}" aspect-ratio="16:9"`,
      `    generate-audio="false" first-frame={${id}-first} first-frame-person-reference="${person}"${last ? ` last-frame={${id}-last} last-frame-person-reference="${person}"` : ""}/>`, "");
    ids.push(`${id}.video`);
    plan.clips.push({ id, seconds: clip, medium: s.medium, model: choice, shots: [{ slot: s.slot, from: 0, to: clip, frames: s.frames, setup: s.setup ?? null, align: "start" }] });
    seconds += clip;
    cost += clip * PIXELS[resolution] * 24 / 1024 * RATE[variant];
  }
  svml.push("</svml>");
  writeRun(out, "frames", ids, svml);
  writeFileSync(join(out, "clips-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(`Wrote ${out}/frames.svml, frames.svrun and clips-plan.json: ${ids.length} clip(s), ${seconds}s, about $${cost.toFixed(2)}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}. Check with: hypit pricing frames.svrun`);
}

const run = { plates, stills, screens, check, frames }[command];
Promise.resolve(run()).catch((error) => { console.error(`keyframes: ${error.message}`); process.exit(1); });
