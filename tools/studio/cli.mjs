#!/usr/bin/env node
// Remake Studio from a shell (or a chat session on the machine that holds the projects): the same engine as the
// web app at /studio and the studio_* MCP tools.
//
//   node tools/studio/cli.mjs <projects dir> list
//   node tools/studio/cli.mjs <projects dir> new <name> <reference video>      (copies it in, then cuts it into shots)
//   node tools/studio/cli.mjs <projects dir> status <project>
//   node tools/studio/cli.mjs <projects dir> brief <project> brand="..." product="..." style="..."
//   node tools/studio/cli.mjs <projects dir> run <project> <step|all|images|video> [--only 3,5] [--model standard-720p]
//
// run waits for the step to finish and prints its log. Paid steps spend OpenRouter credit (OPENROUTER_API_KEY):
// status prints every step's estimate first.

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudio } from "./engine.mjs";

const [rootArg, command, ...rest] = process.argv.slice(2);
if (!rootArg || !command) {
  console.error("Usage: node tools/studio/cli.mjs <projects dir> <list|new|status|brief|run> ...");
  process.exit(1);
}
const studio = createStudio({ root: rootArg, hypitHome: join(dirname(fileURLToPath(import.meta.url)), "..", ".."), python: process.env.STUDIO_PYTHON ?? "python3" });
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);

async function waitFor(id) {
  let shown = "";
  for (;;) {
    const p = studio.get(id);
    const log = p.running?.log ?? "";
    if (log && log !== shown) { process.stdout.write(log.startsWith(shown) ? log.slice(shown.length) : `\n${log}`); shown = log; }
    if (!p.running) return p;
    await new Promise((done) => setTimeout(done, 2000));
  }
}

const commands = {
  list: () => console.table(studio.list().map(({ id, name, done, cost, running }) => ({ id, name, done: done.join(" "), cost, running }))),
  async new() {
    const [name, video] = rest;
    if (!name || !video) throw new Error("new <name> <reference video>");
    mkdirSync(join(resolve(rootArg), "_uploads"), { recursive: true });
    const temp = join(resolve(rootArg), "_uploads", `${Date.now()}.part`);
    copyFileSync(resolve(video), temp);
    const id = studio.create({ name, source: temp, filename: video });
    studio.run(id, "analyze");
    console.log(`Created ${id}; cutting the reference into shots...`);
    const p = await waitFor(id);
    console.log(`\nanalyze: ${p.steps.analyze.state}${p.steps.analyze.error ? ` (${p.steps.analyze.error})` : ""}`);
  },
  status() {
    const p = studio.get(rest[0]);
    console.log(`${p.name} (${p.id}); spent $${p.total.toFixed(2)}`);
    for (const [k, s] of Object.entries(p.steps)) console.log(`  ${k.padEnd(10)} ${s.state.padEnd(11)} estimate $${p.estimate[k] ?? 0}${s.error ? `  ${s.error.slice(0, 120)}` : ""}`);
    for (const s of p.slots) console.log(`  #${String(s.slot).padStart(2)} ${s.stills.first ? "still" : "     "} ${s.clip ? "clip" : "    "} ${s.check ? (s.check.pass ? "pass" : "FAIL") : "    "}  ${s.prompt.slice(0, 90)}`);
  },
  brief() {
    const [id, ...pairs] = rest;
    const brief = Object.fromEntries(pairs.map((x) => x.split(/=(.*)/s)).filter((x) => x.length > 1).map(([k, v]) => [k, v]));
    console.log(studio.setBrief(id, brief));
  },
  async run() {
    const [id, step] = rest;
    const only = option("--only")?.split(",").map(Number);
    console.log(studio.run(id, step, { only, model: option("--model") }));
    const p = await waitFor(id);
    console.log("\n" + Object.entries(p.steps).filter(([, s]) => s.state !== "idle").map(([k, s]) => `${k}: ${s.state}${s.error ? ` (${s.error.slice(0, 200)})` : ""}`).join("\n"));
    console.log(`spent so far $${p.total.toFixed(2)}`);
  },
};
if (!commands[command]) { console.error(`unknown command ${command}`); process.exit(1); }
Promise.resolve(commands[command]()).catch((error) => { console.error(error.message); process.exit(1); });
