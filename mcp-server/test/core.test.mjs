// Unit tests for path safety, link signing and output clipping. Run after `npm run build`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workspace = mkdtempSync(join(tmpdir(), "hypit-mcp-test-"));
process.env.HYPIT_WORKSPACE = workspace;
process.env.MCP_AUTH_TOKEN = "unit-test-token-0123456789abcdef";

const { resolveInside, assertProjectName, UserError } = await import("../dist/paths.js");
const { signedFileUrl, verifySignature, safeEqual } = await import("../dist/signing.js");
const { clip } = await import("../dist/exec.js");

test("project names are restricted", () => {
  assert.equal(assertProjectName("my-video.v2"), "my-video.v2");
  for (const bad of ["", "../x", "Upper", "a/b", ".hidden", "x".repeat(65)]) {
    assert.throws(() => assertProjectName(bad), UserError, bad);
  }
});

test("paths stay inside the project", () => {
  const root = join(workspace, "p1");
  mkdirSync(join(root, "assets"), { recursive: true });
  assert.equal(resolveInside(root, "assets/a.mp4"), join(root, "assets", "a.mp4"));
  assert.equal(resolveInside(root, undefined), root);
  assert.throws(() => resolveInside(root, "../p2/file"), UserError);
  assert.throws(() => resolveInside(root, "/etc/passwd"), UserError);
  assert.throws(() => resolveInside(root, "assets/../../escape"), UserError);
});

test("symlinks that leave the project are refused", () => {
  const root = join(workspace, "p2");
  mkdirSync(root, { recursive: true });
  symlinkSync(tmpdir(), join(root, "outside"));
  assert.throws(() => resolveInside(root, "outside/secret.txt"), UserError);
});

test("signed links verify only for the same method, path and time window", () => {
  const { url } = signedFileUrl("https://example.test", "GET", "p1", "exports/final video.mp4", 60);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/files/p1/exports/final%20video.mp4");
  const exp = parsed.searchParams.get("exp");
  const sig = parsed.searchParams.get("sig");
  assert.ok(verifySignature("GET", "p1", "exports/final video.mp4", exp, sig));
  assert.ok(!verifySignature("PUT", "p1", "exports/final video.mp4", exp, sig));
  assert.ok(!verifySignature("GET", "p1", "exports/other.mp4", exp, sig));
  assert.ok(!verifySignature("GET", "p2", "exports/final video.mp4", exp, sig));
  assert.ok(!verifySignature("GET", "p1", "exports/final video.mp4", String(Number(exp) + 1), sig));
  assert.ok(!verifySignature("GET", "p1", "exports/final video.mp4", "1", sig));
});

test("token comparison", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abcd"));
});

test("clip keeps head and tail", () => {
  const long = `${"a".repeat(100)}MIDDLE${"z".repeat(100)}`;
  const out = clip(long, 50);
  assert.ok(out.startsWith("a".repeat(15)));
  assert.ok(out.endsWith("z".repeat(35)));
  assert.ok(out.includes("characters omitted"));
  assert.equal(clip("short", 50), "short");
});
