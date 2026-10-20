import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
}

const workspace = resolve(process.env.HYPIT_WORKSPACE ?? "/data/projects");
const authToken = process.env.MCP_AUTH_TOKEN?.trim() ?? "";

export const config = {
  port: intFromEnv("PORT", 8080),
  host: process.env.HOST ?? "0.0.0.0",
  /** Shared secret for the MCP endpoint and file routes. */
  authToken,
  /** Only for local development: serve without any token. */
  allowNoAuth: process.env.MCP_ALLOW_NO_AUTH === "1",
  /** Root of the vendored Hypit Distribution (the repository root). */
  hypitHome: resolve(process.env.HYPIT_HOME ?? join(here, "..", "..")),
  /** Where video projects live; on Railway this sits on the mounted volume. */
  workspace,
  jobsDir: resolve(process.env.HYPIT_JOBS_DIR ?? join(workspace, "..", "jobs")),
  /**
   * Reference media the OpenRouter Provider publishes for one request (OpenRouter fetches audio and
   * video references by HTTPS URL). Served without auth under unguessable names, then swept.
   */
  stagingDir: resolve(process.env.HYPIT_STAGING_DIR ?? join(workspace, "..", "staged")),
  stagingMaxAgeHours: intFromEnv("HYPIT_STAGING_MAX_AGE_HOURS", 24),
  /** Base URL used in signed file links; falls back to the Railway domain, then the request host. */
  publicBaseUrl:
    process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ??
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
  signingSecret: process.env.MCP_SIGNING_SECRET?.trim() || authToken,
  enableShell: process.env.MCP_ENABLE_SHELL !== "0",
  defaultTimeoutSeconds: intFromEnv("MCP_DEFAULT_TIMEOUT_SECONDS", 120),
  maxTimeoutSeconds: intFromEnv("MCP_MAX_TIMEOUT_SECONDS", 600),
  maxOutputChars: intFromEnv("MCP_MAX_OUTPUT_CHARS", 60_000),
  maxUploadBytes: intFromEnv("MCP_MAX_UPLOAD_MB", 4096) * 1024 * 1024,
  maxInlineImageBytes: intFromEnv("MCP_MAX_INLINE_IMAGE_KB", 4500) * 1024,
  renderWorkers: process.env.HYPIT_RENDER_WORKERS ? intFromEnv("HYPIT_RENDER_WORKERS", 2) : undefined,
};

export type Config = typeof config;
