// Remake Studio on the hosted server: the web app at /studio, its JSON API, project media, and the studio_* MCP
// tools. The work itself is tools/studio/engine.mjs from the Hypit Distribution, so the web app, a claude.ai
// artifact (through these MCP tools) and a chat session all drive the same projects on the volume.

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomBytes, createHmac } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "./config.js";
import { encodePath, safeEqual, signature, verifySignature } from "./signing.js";

// The engine is plain JavaScript shared with the command line; its shape is described loosely here.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Studio = any;

export const STUDIO_ROOT = join(config.workspace, "..", "studio");
let studioPromise: Promise<Studio> | undefined;

export function loadStudio(): Promise<Studio> {
  studioPromise ??= import(pathToFileURL(join(config.hypitHome, "tools", "studio", "engine.mjs")).href).then(({ createStudio }) =>
    createStudio({ root: STUDIO_ROOT, hypitHome: config.hypitHome, python: process.env.STUDIO_PYTHON ?? "python3", env: process.env }),
  );
  return studioPromise;
}

/** The session cookie is an HMAC of a constant under the signing secret: it proves the token was given once. */
function sessionValue(): string {
  return createHmac("sha256", config.signingSecret || "no-auth").update("remake-studio-session").digest("hex");
}
function hasSession(req: Request): boolean {
  if (config.allowNoAuth && !config.authToken) return true;
  const cookie = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)studio_session=([a-f0-9]{64})/.exec(cookie);
  if (match && safeEqual(match[1], sessionValue())) return true;
  const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
  return header !== undefined && !!config.authToken && safeEqual(header, config.authToken);
}
function setSession(res: Response): void {
  res.cookie("studio_session", sessionValue(), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 30 * 86_400_000, path: "/studio" });
}

/** A time-limited link to one project file, for chat and artifacts (which cannot carry the cookie). */
export function studioLink(baseUrl: string, project: string, path: string, seconds = 6 * 3600): string {
  const expires = Math.floor(Date.now() / 1000) + seconds;
  return `${baseUrl}/studio/media/${encodeURIComponent(project)}/${encodePath(path)}?exp=${expires}&sig=${signature("GET", `studio:${project}`, path, expires)}`;
}

const LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Remake Studio</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1012;color:#e9e9ea;font:15px/1.5 system-ui,sans-serif}
form{background:#17191c;border:1px solid #2a2d32;border-radius:12px;padding:24px;width:min(360px,90vw)}h1{font-size:18px;margin:0 0 12px}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a2d32;background:#22252a;color:inherit;margin-top:8px}
button{background:#3b6fd8;border-color:#3b6fd8;cursor:pointer}p{color:#9a9ca1;font-size:13px}</style></head><body>
<form method="post" action="/studio/login"><h1>Remake Studio</h1><p>Enter the server's access token (the MCP_AUTH_TOKEN variable in Railway).</p>
<input type="password" name="token" placeholder="Access token" autocomplete="current-password" required><button>Open the studio</button></form></body></html>`;

export function mountStudio(app: Express): void {
  const auth = (req: Request, res: Response, next: NextFunction) => (hasSession(req) ? next() : res.status(401).json({ error: "Sign in to the studio first." }));
  const wrap = (handler: (req: Request, res: Response, studio: Studio) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      const studio = await loadStudio();
      const result = await handler(req, res, studio);
      if (!res.headersSent) res.json(result ?? { ok: true });
    } catch (error) {
      if (!res.headersSent) res.status(/no project|not found|outside/.test(String((error as Error).message)) ? 404 : 400).json({ error: (error as Error).message });
    }
  };
  const body = express.json({ limit: "2mb" });

  app.get("/studio", async (req, res) => {
    if (!hasSession(req)) return void res.type("html").send(LOGIN_PAGE);
    res.set("Cache-Control", "no-store").sendFile(join(config.hypitHome, "tools", "studio", "ui", "index.html"));
  });
  app.post("/studio/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const token = String(req.body?.token ?? "");
    if (!config.authToken || !safeEqual(token, config.authToken)) return void res.status(401).type("html").send(LOGIN_PAGE.replace("<h1>Remake Studio</h1>", "<h1>Remake Studio</h1><p style='color:#ffb3aa'>That token is not right.</p>"));
    setSession(res);
    res.redirect(303, "/studio");
  });
  app.get("/studio/key/:token", (req, res) => {
    if (!config.authToken || !safeEqual(String(req.params.token), config.authToken)) return void res.status(401).type("text/plain").send("Unauthorized.\n");
    setSession(res);
    res.redirect(303, "/studio");
  });

  app.get("/studio/api/projects", auth, wrap((_req, _res, studio) => ({ projects: studio.list(), steps: studio.STEPS, chains: studio.CHAINS, rates: studio.RATES })));
  app.get("/studio/api/projects/:id", auth, wrap((req, _res, studio) => studio.get(String(req.params.id))));
  app.post("/studio/api/projects", auth, wrap(async (req, _res, studio) => {
    const name = String(req.query.name ?? "Untitled remake").slice(0, 80);
    const filename = String(req.query.filename ?? "reference.mp4").replace(/[^\w.-]/g, "_");
    const source = await receiveUpload(req);
    const id = studio.create({ name, source, filename });
    studio.run(id, "analyze");
    return { id };
  }));
  app.put("/studio/api/projects/:id/brief", auth, body, wrap((req, _res, studio) => studio.setBrief(String(req.params.id), req.body)));
  app.put("/studio/api/projects/:id/slots/:slot", auth, body, wrap((req, _res, studio) => studio.editSlot(String(req.params.id), Number(req.params.slot), req.body ?? {})));
  app.put("/studio/api/projects/:id/voice/:phrase", auth, body, wrap((req, _res, studio) => studio.editLine(String(req.params.id), Number(req.params.phrase), String(req.body?.line ?? ""))));
  app.put("/studio/api/projects/:id/decisions", auth, body, wrap((req, _res, studio) => studio.setDecisions(String(req.params.id), req.body?.decisions ?? req.body)));
  app.post("/studio/api/projects/:id/run", auth, body, wrap((req, _res, studio) =>
    studio.run(String(req.params.id), Array.isArray(req.body?.step) ? req.body.step.map(String) : String(req.body?.step), { only: Array.isArray(req.body?.only) ? req.body.only.map(Number) : undefined, model: req.body?.model })));
  app.post("/studio/api/projects/:id/stop", auth, wrap((req, _res, studio) => ({ stopped: studio.stop(String(req.params.id)) })));
  app.get("/studio/api/projects/:id/log/:step", auth, wrap((req, _res, studio) => ({ log: studio.log(String(req.params.id), String(req.params.step), 400) })));

  // Project media: the cookie (web app) or a signed link (chat, artifacts). ?w= returns a cached JPEG thumbnail.
  app.get("/studio/media/:id/*path", async (req, res) => {
    const id = String(req.params.id);
    const segments = req.params.path as unknown as string[] | string;
    const path = Array.isArray(segments) ? segments.join("/") : String(segments);
    const signed = verifySignature("GET", `studio:${id}`, path, typeof req.query.exp === "string" ? req.query.exp : undefined,
      typeof req.query.sig === "string" ? req.query.sig : undefined);
    if (!signed && !hasSession(req)) return void res.status(403).type("text/plain").send("Link is invalid or expired.\n");
    try {
      const studio = await loadStudio();
      const target = req.query.w ? studio.thumb(id, path, Number(req.query.w)) : studio.file(id, path);
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) return void res.status(404).type("text/plain").send("Not found.\n");
      res.sendFile(target, { dotfiles: "allow", headers: { "Cache-Control": "private, max-age=60" } });
    } catch (error) {
      res.status(404).type("text/plain").send(`${(error as Error).message}\n`);
    }
  });
}

/** Stream a request body to a temporary file on the volume (the studio moves it into the new project). */
async function receiveUpload(req: Request): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > config.maxUploadBytes) throw new Error("The video is larger than the upload limit.");
  await mkdir(join(STUDIO_ROOT, "_uploads"), { recursive: true });
  const temp = join(STUDIO_ROOT, "_uploads", `${Date.now()}-${randomBytes(4).toString("hex")}.part`);
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > config.maxUploadBytes) req.destroy(new Error("Upload exceeds the size limit."));
  });
  try {
    await pipeline(req, createWriteStream(temp));
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  if (received < 1024) {
    await rm(temp, { force: true });
    throw new Error("The upload is empty.");
  }
  return temp;
}

// ---------- MCP tools ----------

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}
function fail(error: unknown): CallToolResult {
  return { content: [{ type: "text", text: (error as Error).message ?? String(error) }], isError: true };
}

/** Plain-text summary of a project for chat: steps, costs, per-shot state, links. */
function summarise(project: any, baseUrl: string): string {
  const steps = Object.entries(project.steps).map(([k, s]: [string, any]) => `${k}: ${s.state}${s.error ? ` (${String(s.error).slice(0, 160)})` : ""}`).join("; ");
  const shots = project.slots.map((s: any) => `#${s.slot} ${s.duration.toFixed(2)}s ${s.labels.shot_size ?? ""} ${s.labels.people_count ?? "?"}p` +
    `${s.stills.first ? " still" : ""}${s.clip ? " clip" : ""}${s.check ? (s.check.pass ? " pass" : " FAIL") : ""}${s.decision ? ` [${s.decision.model}${s.decision.approve ? ", approved" : ""}]` : ""}` +
    ` - ${String(s.prompt).slice(0, 110)}`).join("\n");
  const e = project.estimate;
  return [`${project.name} (${project.id})`, `Steps: ${steps}`, project.running ? `Running: ${project.running.step}\n${project.running.log.split("\n").slice(-6).join("\n")}` : "",
    `Spent: $${project.total.toFixed(2)}. Estimates: draft $${e.draft}, cast $${e.cast}, plates $${e.plates}, stills $${e.stills}, animate $${e.animate} (${e.animateSeconds}s), soundtrack $${e.soundtrack}.`,
    project.checkSummary ? `Stills check: ${project.checkSummary.pass} of ${project.checkSummary.total} shots pass.` : "",
    project.final.video ? `Final cut: ${studioLink(baseUrl, project.id, project.final.video)}` : "",
    project.compare ? `Format-critical: ${project.compare.criticalPassed} of ${project.compare.criticalTotal}.` : "",
    `Open in the studio: ${baseUrl}/studio`, "", "Shots:", shots].filter(Boolean).join("\n");
}

export function registerStudioTools(server: McpServer, baseUrl: string): void {
  const tool = (name: string, title: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: any, studio: Studio) => Promise<CallToolResult> | CallToolResult, readOnly = false) =>
    server.registerTool(name, { title, description, inputSchema, annotations: { readOnlyHint: readOnly } }, async (args: any) => {
      try { return await handler(args, await loadStudio()); } catch (error) { return fail(error); }
    });
  const project = z.string().describe("Project id from studio_list");

  tool("studio_list", "List remake projects", "List the Remake Studio projects (a reference video remade shot by shot), newest first, with the steps done and money spent.",
    {}, (_a, studio) => text(JSON.stringify(studio.list(), null, 2)), true);

  tool("studio_status", "Show a remake project", "One project: every step's state, what is running (with its log), money spent and estimates, and each shot's still, clip, check result and choice. Pass json=true for the full machine-readable state.",
    { project, json: z.boolean().optional() }, ({ project: id, json }, studio) => {
      const p = studio.get(id);
      return text(json ? JSON.stringify(p) : summarise(p, baseUrl));
    }, true);

  tool("studio_create", "Start a remake from a reference video URL", "Download a reference video from an https URL into a new project and start cutting it into shots (about $0.02 per shot of labelling). For a file the user has, use the studio web app or studio_upload_chunk.",
    { name: z.string(), video_url: z.string().url() }, async ({ name, video_url }, studio) => {
      if (!/^https:\/\//.test(video_url)) throw new Error("Use an https URL.");
      const response = await fetch(video_url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
      await mkdir(join(STUDIO_ROOT, "_uploads"), { recursive: true });
      const temp = join(STUDIO_ROOT, "_uploads", `${Date.now()}-${randomBytes(4).toString("hex")}.part`);
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), createWriteStream(temp));
      const id = studio.create({ name, source: temp, filename: new URL(video_url).pathname.split("/").pop() || "reference.mp4" });
      studio.run(id, "analyze");
      return text(`Created ${id} and started cutting the reference into shots. Check progress with studio_status.`);
    });

  tool("studio_upload_chunk", "Upload a reference video in pieces", "Send a reference video as base64 pieces (up to 8 MB each, in order). The first call omits upload_id and gets one back; the last piece (index = total - 1) creates the project and starts analysis.",
    { upload_id: z.string().regex(/^[a-f0-9]{16}$/).optional(), index: z.number().int().min(0), total: z.number().int().min(1).max(200), data_base64: z.string(),
      name: z.string().optional(), filename: z.string().optional() }, async ({ upload_id, index, total, data_base64, name, filename }, studio) => {
      const id = upload_id ?? randomBytes(8).toString("hex");
      const part = join(STUDIO_ROOT, "_uploads", `${id}.chunked`);
      await mkdir(join(STUDIO_ROOT, "_uploads"), { recursive: true });
      const bytes = Buffer.from(data_base64, "base64");
      if (bytes.length > 8 * 1024 * 1024) throw new Error("Pieces are at most 8 MB.");
      const size = existsSync(part) ? (await stat(part)).size : 0;
      if (index === 0 && size) await rm(part);
      await new Promise<void>((done, failed) => { const w = createWriteStream(part, { flags: "a" }); w.on("error", failed); w.end(bytes, () => done()); });
      if (index < total - 1) return text(JSON.stringify({ upload_id: id, received: index + 1, total }));
      const projectId = studio.create({ name: name ?? "Untitled remake", source: part, filename: filename ?? "reference.mp4" });
      studio.run(projectId, "analyze");
      return text(JSON.stringify({ upload_id: id, project: projectId, started: "analyze" }));
    });

  tool("studio_brief", "Set the remake's brief", "Our side of the remake: brand, product, offer, audience, tone, visual style, characters and notes. The draft step turns the brief and the measured format into our version of every shot.",
    { project, brand: z.string(), product: z.string().optional(), offer: z.string().optional(), audience: z.string().optional(), tone: z.string().optional(),
      style: z.string().optional(), characters: z.string().optional(), notes: z.string().optional() },
    ({ project: id, ...brief }, studio) => text(JSON.stringify(studio.setBrief(id, brief))));

  tool("studio_run", "Run a remake step", "Start a step in the background: analyze, draft, cast, plates, stills, check, animate, soundtrack, final or compare; a chain: all (draft to check), images (plates, stills, check), video (animate, soundtrack, final); or a list of steps run in order (for example animate then final). only=[slots] limits stills or animate to those shots; model sets every animated shot's Seedance model (mini-720p, fast-720p, standard-720p, standard-1080p). Paid steps spend OpenRouter credit: read the estimates in studio_status first and confirm the cost with the user.",
    { project, step: z.union([z.string(), z.array(z.string()).min(1).max(10)]), only: z.array(z.number().int()).optional(), model: z.enum(["mini-720p", "fast-720p", "standard-720p", "standard-1080p"]).optional() },
    ({ project: id, step, only, model }, studio) => text(JSON.stringify(studio.run(id, step, { only, model }))));

  tool("studio_stop", "Stop the running step", "Stop a project's running step.", { project }, ({ project: id }, studio) => text(JSON.stringify({ stopped: studio.stop(id) })));

  tool("studio_edit_shot", "Rewrite one shot", "Change one shot's prompt or opening frame (then rerun stills with only=[slot]), or waive a checked field with a reason ({field: reason}).",
    { project, slot: z.number().int(), prompt: z.string().optional(), first_frame: z.string().optional(), waive: z.record(z.string()).optional() },
    ({ project: id, slot, prompt, first_frame, waive }, studio) => text(JSON.stringify(studio.editSlot(id, slot, { prompt, firstFrame: first_frame, waive }))));

  tool("studio_edit_line", "Rewrite a voice line", "Change one voiceover line (keep its word count and role).", { project, phrase: z.number().int(), line: z.string() },
    ({ project: id, phrase, line }, studio) => text(JSON.stringify(studio.editLine(id, phrase, line))));

  tool("studio_decide", "Choose models and approve shots", "Per shot: the Seedance model to animate it with (mini-720p, fast-720p, standard-720p, standard-1080p or skip), whether it is approved, and a director's note for its animation.",
    { project, decisions: z.record(z.object({ model: z.string().optional(), approve: z.boolean().optional(), note: z.string().optional() })) },
    ({ project: id, decisions }, studio) => text(JSON.stringify(studio.setDecisions(id, decisions))));

  tool("studio_images", "Show shots as images", "Images of a project for review: for each shot asked for (all by default), the reference frame and our opening still side by side as small JPEGs, plus a line of what the check found.",
    { project, slots: z.array(z.number().int()).optional(), width: z.number().int().min(160).max(640).optional() }, async ({ project: id, slots, width }, studio) => {
      const p = studio.get(id), w = width ?? 320, content: CallToolResult["content"] = [];
      for (const s of p.slots.filter((x: any) => !slots || slots.includes(x.slot)).slice(0, 24)) {
        const misses = (s.check?.misses ?? []).filter((m: any) => m.critical && !m.waived).map((m: any) => `${m.field}: ${m.got} (want ${m.want})`);
        content.push({ type: "text", text: `Shot ${s.slot} (${s.duration.toFixed(2)}s): ${s.check ? (s.check.pass ? "passes" : `fails: ${misses.join("; ")}`) : "not checked"} - ${String(s.prompt).slice(0, 140)}` });
        for (const rel of [s.reference[1] ?? s.reference[0], s.stills.first].filter(Boolean)) {
          const data = await readFile(studio.thumb(id, rel, w));
          content.push({ type: "image", data: data.toString("base64"), mimeType: "image/jpeg" });
        }
      }
      return { content };
    }, true);

  tool("studio_media", "Fetch a project file's bytes", "A project file as base64 for a page to show (an artifact cannot load the server's URLs): the reference's playback copy reference/proxy.mp4, the cut's final/proxy.mp4, a clip slots/slot-03.mp4, or an image. At most 15 MB; videos are 640 px playback copies. width returns a JPEG of that width instead (an image, or a video's first frame).",
    { project, path: z.string(), width: z.number().int().min(64).max(1280).optional() }, async ({ project: id, path, width }, studio) => {
      if (width) return text(JSON.stringify({ path, mime: "image/jpeg", base64: (await readFile(studio.thumb(id, path, width))).toString("base64") }));
      const target = studio.file(id, path);
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`No file at ${path}.`);
      if (info.size > 15 * 1024 * 1024) throw new Error("The file is larger than 15 MB; use studio_link for it.");
      const ext: string = String(path).split(".").pop()?.toLowerCase() ?? "";
      const mime = ({ mp4: "video/mp4", webm: "video/webm", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", wav: "audio/wav", mp3: "audio/mpeg", json: "application/json" } as Record<string, string>)[ext] ?? "application/octet-stream";
      return text(JSON.stringify({ path, mime, size: info.size, base64: (await readFile(target)).toString("base64") }));
    }, true);

  tool("studio_link", "Link to a project file", "A time-limited https link to a project file (the final cut final/final.mp4, a clip slots/slot-03.mp4, a still stills/slot-03.png) that opens in a browser.",
    { project, path: z.string(), hours: z.number().min(0.1).max(72).optional() }, ({ project: id, path, hours }, studio) => {
      studio.file(id, path);
      return text(studioLink(baseUrl, id, path, Math.round((hours ?? 6) * 3600)));
    }, true);
}
