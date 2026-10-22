// Runtime Profile adaptation for new projects. Run after `npm run build`.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.MCP_AUTH_TOKEN ??= "unit-test-token-0123456789abcdef";
const { adaptProfile, OPENROUTER_CAPABILITIES } = await import("../dist/profile.js");

function project(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hypit-profile-"));
  writeFileSync(join(dir, "hypit.runtime.json"), JSON.stringify({
    format: "hypit.runtime-local@1", dataRoot: ".hypit/runtimes/local",
    credentials: { local: { use: "@hypit/credential-store-local" } },
    endpoints: {
      "hypihub.default": { use: "@hypit/provider-hypihub", config: { apiKey: { store: "local", key: "hypihub.oauth" } } },
      "html.local": { use: "@hypit/provider-html-local" },
    },
    ...extra,
  }));
  return dir;
}
const read = (dir) => JSON.parse(readFileSync(join(dir, "hypit.runtime.json"), "utf8"));

test("an OpenRouter key adds the Endpoint and binds every OpenRouter Capability", async () => {
  const dir = project();
  const notes = await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or", OPENROUTER_GPT_IMAGE_QUALITY: "low" }, renderWorkers: 2 });
  const profile = read(dir);
  assert.deepEqual(profile.endpoints["openrouter.default"], {
    use: "@hypit/provider-openrouter", pool: "openrouter.default",
    config: { apiKey: { store: "env", key: "OPENROUTER_API_KEY" }, gptImageQuality: "low" },
  });
  assert.equal(Object.keys(profile.bindings).length, OPENROUTER_CAPABILITIES.length);
  assert.ok(Object.values(profile.bindings).every((endpoint) => endpoint === "openrouter.default"));
  assert.deepEqual(profile.credentials.env, { use: "@hypit/credential-store-env" });
  assert.equal(profile.endpoints["html.local"].config.workers, 2);
  assert.ok(notes.some((note) => note.includes("seedance-2-mini")));
});

test("without a key nothing is bound, and existing bindings survive a rerun", async () => {
  const dir = project({ bindings: { "@hypit/seedance@1#seedance-2": "hypihub.default" } });
  const without = await adaptProfile(dir, { env: {} });
  assert.equal(read(dir).endpoints["openrouter.default"], undefined);
  assert.ok(without.some((note) => note.includes("OPENROUTER_API_KEY is not set")));
  await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or", HYPIT_HUB_API_KEY: "hub" } });
  const profile = read(dir);
  assert.equal(profile.bindings["@hypit/seedance@1#seedance-2"], "hypihub.default");
  assert.equal(profile.bindings["@hypit/seedance@1#seedance-2-mini"], "openrouter.default");
  assert.deepEqual(profile.endpoints["hypihub.default"].config.apiKey, { store: "env", key: "HYPIT_HUB_API_KEY" });
});

test("an HTTPS address lets OpenRouter fetch staged audio and video references, also on a rerun", async () => {
  const dir = project();
  await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or" } });
  assert.equal(read(dir).endpoints["openrouter.default"].config.stagingBaseUrl, undefined);
  const staging = { directory: "/data/staged", baseUrl: "https://hypit.example.test/staged" };
  const notes = await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or" }, staging });
  const config = read(dir).endpoints["openrouter.default"].config;
  assert.equal(config.stagingDirectory, "/data/staged");
  assert.equal(config.stagingBaseUrl, "https://hypit.example.test/staged");
  assert.ok(notes.some((note) => note.includes("/staged")));

  const local = project();
  const refused = await adaptProfile(local, { env: { OPENROUTER_API_KEY: "sk-or" }, staging: { directory: "/x", baseUrl: "http://127.0.0.1:8080/staged" } });
  assert.equal(read(local).endpoints["openrouter.default"].config.stagingBaseUrl, undefined);
  assert.ok(refused.some((note) => note.includes("refuses audio and video references")));
});

test("projects share one OpenRouter job ledger, added on a rerun and never overwritten", async () => {
  const dir = project();
  await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or" } });
  assert.equal(read(dir).endpoints["openrouter.default"].config.jobLedgerPath, undefined);
  const notes = await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or" }, jobLedgerPath: "/data/openrouter-jobs.json" });
  assert.equal(read(dir).endpoints["openrouter.default"].config.jobLedgerPath, "/data/openrouter-jobs.json");
  assert.ok(notes.some((note) => note.includes("reuses them instead of paying again")));
  await adaptProfile(dir, { env: { OPENROUTER_API_KEY: "sk-or" }, jobLedgerPath: "/elsewhere.json" });
  assert.equal(read(dir).endpoints["openrouter.default"].config.jobLedgerPath, "/data/openrouter-jobs.json");
});
