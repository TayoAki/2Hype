import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { existingProjectDir, resolveInside, UserError } from "./paths.js";
import { safeEqual, verifySignature, type LinkMethod } from "./signing.js";
import { mountStudio, registerStudioTools } from "./studio.js";
import { registerHypitTools, SERVER_INSTRUCTIONS } from "./tools.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const hypitVersion = (() => {
  try {
    return (JSON.parse(readFileSync(join(config.hypitHome, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

if (!config.authToken && !config.allowNoAuth) {
  console.error("MCP_AUTH_TOKEN is required. Set it to a long random string (or MCP_ALLOW_NO_AUTH=1 for local development only).");
  process.exit(1);
}
if (config.authToken && config.authToken.length < 24) {
  console.error("MCP_AUTH_TOKEN must be at least 24 characters.");
  process.exit(1);
}

function requestBaseUrl(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || req.protocol;
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

function bearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function tokenMatches(candidate: string | undefined): boolean {
  if (config.allowNoAuth && !config.authToken) return true;
  return candidate !== undefined && safeEqual(candidate, config.authToken);
}

function unauthorized(res: Response): void {
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `Hypit MCP server ${pkg.version} (Hypit ${hypitVersion}).\nMCP endpoint: POST /mcp with "Authorization: Bearer <token>", or /mcp/<token> for clients that cannot send headers.\n`,
  );
});

// Remake Studio: the web app at /studio, its API and media (see studio.ts).
mountStudio(app);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, server: pkg.version, hypit: hypitVersion });
});

async function handleMcp(req: Request, res: Response): Promise<void> {
  const server = new McpServer(
    { name: "hypit", title: "Hypit video production", version: pkg.version },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerHypitTools(server, requestBaseUrl(req));
  registerStudioTools(server, requestBaseUrl(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "This stateless server only accepts POST." }, id: null });
}

const mcpJson = express.json({ limit: "64mb" });

app.post("/mcp", (req, res, next) => (tokenMatches(bearer(req)) ? next() : unauthorized(res)), mcpJson, handleMcp);
app.post(
  "/mcp/:token",
  (req, res, next) => (tokenMatches(String(req.params.token)) ? next() : unauthorized(res)),
  mcpJson,
  handleMcp,
);
app.get(["/mcp", "/mcp/:token"], methodNotAllowed);
app.delete(["/mcp", "/mcp/:token"], methodNotAllowed);

function fileAccess(method: LinkMethod) {
  return (req: Request, res: Response, next: NextFunction) => {
    const project = String(req.params.project);
    const segments = req.params.path as unknown as string[] | string;
    const path = Array.isArray(segments) ? segments.join("/") : String(segments);
    const signed = verifySignature(
      method,
      project,
      path,
      typeof req.query.exp === "string" ? req.query.exp : undefined,
      typeof req.query.sig === "string" ? req.query.sig : undefined,
    );
    if (!signed && !tokenMatches(bearer(req))) {
      res.status(403).type("text/plain").send("Link is invalid or expired.\n");
      return;
    }
    try {
      res.locals.target = resolveInside(existingProjectDir(project), path);
      res.locals.relative = path;
      next();
    } catch (error) {
      res.status(error instanceof UserError ? 400 : 500).type("text/plain").send(`${(error as Error).message}\n`);
    }
  };
}

app.get("/files/:project/*path", fileAccess("GET"), async (_req, res) => {
  const target = res.locals.target as string;
  const info = await stat(target).catch(() => undefined);
  if (!info?.isFile()) {
    res.status(404).type("text/plain").send("Not found.\n");
    return;
  }
  res.sendFile(target, { dotfiles: "allow", headers: { "Cache-Control": "private, no-store" } });
});

app.put("/files/:project/*path", fileAccess("PUT"), async (req, res) => {
  const target = res.locals.target as string;
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > config.maxUploadBytes) {
    res.status(413).type("text/plain").send("File is larger than the upload limit.\n");
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.upload-${process.pid}-${Date.now()}`;
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > config.maxUploadBytes) req.destroy(new Error("Upload exceeds the size limit."));
  });
  try {
    await pipeline(req, createWriteStream(temp));
    await rename(temp, target);
    res.status(201).type("text/plain").send(`Uploaded ${received} bytes to ${res.locals.relative}\n`);
  } catch (error) {
    await rm(temp, { force: true });
    if (!res.headersSent) res.status(500).type("text/plain").send(`Upload failed: ${(error as Error).message}\n`);
  }
});

/** Names the OpenRouter Provider gives staged references: 128 random bits and a media extension. */
const STAGED_NAME = /^[0-9a-f]{32}\.(wav|mp3|mp4|mov|webm|bin)$/;

app.get("/staged/:name", async (req, res) => {
  const name = String(req.params.name);
  const info = STAGED_NAME.test(name) ? await stat(join(config.stagingDir, name)).catch(() => undefined) : undefined;
  if (!info?.isFile()) {
    res.status(404).type("text/plain").send("Not found.\n");
    return;
  }
  res.sendFile(join(config.stagingDir, name), { headers: { "Cache-Control": "private, no-store" } });
});

/** Staged references only need to outlive the generation request that fetches them. */
async function sweepStaged(): Promise<void> {
  const cutoff = Date.now() - config.stagingMaxAgeHours * 3_600_000;
  for (const name of await readdir(config.stagingDir).catch(() => [] as string[])) {
    const path = join(config.stagingDir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
  }
}

await mkdir(config.workspace, { recursive: true });
await mkdir(config.stagingDir, { recursive: true });
void sweepStaged();
setInterval(() => void sweepStaged(), 3_600_000).unref();
if (!existsSync(join(config.hypitHome, "bin", "hypit.mjs"))) {
  console.error(`Hypit Distribution not found at ${config.hypitHome}; set HYPIT_HOME.`);
  process.exit(1);
}

const httpServer = app.listen(config.port, config.host, () => {
  console.log(
    `Hypit MCP ${pkg.version} listening on ${config.host}:${config.port} (Hypit ${hypitVersion}, workspace ${config.workspace}, shell ${config.enableShell ? "on" : "off"})`,
  );
});
// Long tool calls (renders, installs) can run for minutes inside one request.
httpServer.requestTimeout = 0;
httpServer.headersTimeout = 65_000;
httpServer.keepAliveTimeout = 61_000;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down.`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
