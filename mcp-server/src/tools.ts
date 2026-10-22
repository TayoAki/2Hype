import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.js";
import { clip, getJob, jobSummary, listJobs, readJobLog, runProcess, startJob, stopJob } from "./exec.js";
import {
  assertProjectName,
  existingProjectDir,
  isInside,
  projectDir,
  resolveInside,
  toPosix,
  UserError,
} from "./paths.js";
import { adaptProfile } from "./profile.js";
import { REMOTE_NOTES } from "./remote-notes.js";
import { signedFileUrl } from "./signing.js";

export const SERVER_INSTRUCTIONS = `Hypit turns agents into video producers: clone a reference video or describe one, author SVML/SVRun sources, and render with local HTML rendering plus hosted generation models. This server runs Hypit remotely. Start by calling hypit_docs (no arguments) to read the Hypit Skill and the remote-usage notes, then create or pick a project with project_create / project_list. To remake a reference advert shot by shot (Remake Studio), use the studio_* tools: studio_list, studio_status, studio_brief, studio_run, studio_images, studio_decide; the same projects open in the web app at /studio.`;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".jsonl", ".svml", ".svrun", ".svs", ".ts", ".tsx", ".js", ".mjs", ".cjs",
  ".css", ".html", ".htm", ".yaml", ".yml", ".toml", ".log", ".csv", ".tsv", ".srt", ".vtt", ".ass",
  ".xml", ".svg", ".py", ".sh", ".env.example", ".gitignore",
]);

const DOC_ROOTS = ["skills", "docs", "examples", "packages", "migrations"];
const DOC_ROOT_FILES = new Set(["README.md", "CONTRIBUTING.md", "LICENSE"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".pnpm-store"]);

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function json(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2));
}

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so UserErrors and filesystem errors come back as tool errors, not protocol errors. */
function guarded<A>(handler: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(error instanceof UserError ? message : `Error: ${message}`);
    }
  };
}

function timeoutFor(requested: number | undefined): number {
  return Math.min(Math.max(1, requested ?? config.defaultTimeoutSeconds), config.maxTimeoutSeconds);
}

async function isProbablyText(path: string): Promise<boolean> {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (IMAGE_TYPES[ext]) return false;
  const handle = await readFile(path).catch(() => undefined);
  if (!handle) return false;
  const sample = handle.subarray(0, 8192);
  return !sample.includes(0);
}

function sliceLines(content: string, offset: number | undefined, limit: number | undefined): string {
  const lines = content.split("\n");
  const start = Math.max(1, offset ?? 1);
  const count = Math.max(1, limit ?? 2000);
  const selected = lines.slice(start - 1, start - 1 + count);
  const header =
    lines.length > selected.length
      ? `[lines ${start}-${start - 1 + selected.length} of ${lines.length}; pass offset/limit for more]\n`
      : "";
  return header + clip(selected.join("\n"), 120_000);
}

async function listTree(
  root: string,
  dir: string,
  recursive: boolean,
  maxEntries: number,
  out: string[] = [],
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= maxEntries) break;
    const full = join(dir, entry.name);
    const rel = toPosix(relative(root, full));
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      if (recursive && !SKIP_DIRS.has(entry.name)) await listTree(root, full, recursive, maxEntries, out);
    } else {
      const info = await stat(full).catch(() => undefined);
      out.push(`${rel}  ${info ? formatBytes(info.size) : "?"}  ${info ? info.mtime.toISOString() : ""}`);
    }
  }
  return out;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Map Skill-relative links and package names onto Distribution paths. */
function normalizeDocPath(input: string | undefined): string {
  let path = (input ?? "").trim().replace(/#.*$/, "").replace(/^\.\//, "").replace(/^\/+/, "");
  if (path === "" || path === "SKILL.md") return "skills/hypit/SKILL.md";
  if (path.startsWith("references/") || path.startsWith("agents/")) return `skills/hypit/${path}`;
  const pkg = /^@hypit\/([a-z0-9-]+)$/.exec(path);
  if (pkg) return `packages/${pkg[1]}/README.md`;
  return path;
}

function formatProcess(
  label: string,
  result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string },
  timeoutSeconds: number,
): CallToolResult {
  const status = result.timedOut
    ? `timed out after ${timeoutSeconds}s (process group terminated; rerun with background: true for long work)`
    : `exit ${result.exitCode ?? result.signal}`;
  const body = `$ ${label}\n[${status}, ${(result.durationMs / 1000).toFixed(1)}s]\n\n${clip(result.output) || "(no output)"}`;
  return { content: [{ type: "text", text: body }], isError: result.timedOut || result.exitCode !== 0 };
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function registerHypitTools(server: McpServer, baseUrl: string): void {
  const hypitLauncher = join(config.hypitHome, "bin", "hypit.mjs");

  server.registerPrompt(
    "hypit",
    {
      title: "Hypit video producer",
      description: "Load the Hypit Skill and remote-server notes, then work on a video request.",
      argsSchema: { request: z.string().optional().describe("What video to make or change") },
    },
    async ({ request }) => {
      const skill = await readFile(join(config.hypitHome, "skills", "hypit", "SKILL.md"), "utf8");
      const body = `${skill}\n\n---\n\n${REMOTE_NOTES}\n\n---\n\nUser request: ${request?.trim() || "(none yet: ask what video they want)"}`;
      return { messages: [{ role: "user", content: { type: "text", text: body } }] };
    },
  );

  server.registerTool(
    "hypit_docs",
    {
      title: "Read Hypit Skill and docs",
      description:
        "Read the Hypit Skill, its references, package READMEs and examples from the server's Hypit Distribution. No path returns SKILL.md plus remote-usage notes and the reference index. Paths may be Skill-relative (references/production/runs.md), repository-relative (packages/provider-hypihub/README.md, examples/podcast/README.md) or a package name (@hypit/seedance). A directory path lists its files.",
      inputSchema: {
        path: z.string().optional(),
        offset: z.number().int().positive().optional().describe("First line to return, 1-based"),
        limit: z.number().int().positive().optional().describe("Maximum lines to return (default 2000)"),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ path, offset, limit }) => {
      const root = config.hypitHome;
      const normalized = normalizeDocPath(path);
      const first = normalized.split("/")[0];
      if (!DOC_ROOTS.includes(first) && !DOC_ROOT_FILES.has(normalized)) {
        throw new UserError(`Docs paths start with ${DOC_ROOTS.join(", ")} or name a root file (README.md, LICENSE).`);
      }
      if (normalized.split("/").some((segment) => SKIP_DIRS.has(segment))) {
        throw new UserError("Build output and dependency folders are not part of the docs.");
      }
      const target = resolveInside(root, normalized);
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new UserError(`No docs file at ${normalized}.`);
      if (info.isDirectory()) {
        const entries = await listTree(root, target, true, 400);
        return text(`${normalized}/\n${entries.join("\n")}`);
      }
      const content = await readFile(target, "utf8");
      if (path === undefined || path.trim() === "" || normalized === "skills/hypit/SKILL.md") {
        const index = await listTree(root, join(root, "skills", "hypit", "references"), true, 400);
        return text(
          `${sliceLines(content, offset, limit)}\n\n---\n\n${REMOTE_NOTES}\n\n---\n\nReference files (pass these paths to hypit_docs):\n${index.join("\n")}`,
        );
      }
      return text(sliceLines(content, offset, limit));
    }),
  );

  server.registerTool(
    "project_list",
    {
      title: "List video projects",
      description: "List the Hypit video projects stored on the server.",
      annotations: { readOnlyHint: true },
    },
    guarded(async () => {
      await mkdir(config.workspace, { recursive: true });
      const entries = await readdir(config.workspace, { withFileTypes: true });
      const projects = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(config.workspace, entry.name);
        if (!existsSync(join(dir, "package.json"))) continue;
        const info = await stat(dir);
        const results = await readdir(join(dir, ".hypit", "results")).catch(() => []);
        projects.push({
          name: entry.name,
          hasProfile: existsSync(join(dir, "hypit.runtime.json")),
          results: results.length,
          modified: info.mtime.toISOString(),
        });
      }
      return json({ workspace: config.workspace, projects });
    }),
  );

  server.registerTool(
    "project_create",
    {
      title: "Create a video project",
      description:
        "Create a Hypit project on the server (package.json with hypit.project=true), run `hypit runtime init`, and adapt the Runtime Profile to this server: an env credential store, OpenRouter (bound for Seedance, Grok Imagine, MiniMax H3, GPT Image 2 and Nano Banana) when OPENROUTER_API_KEY is set, HypiHub's key when HYPIT_HUB_API_KEY is set, and the configured render worker count. Safe to rerun on an existing project; it keeps existing files.",
      inputSchema: {
        name: z.string().describe("Project folder name: lowercase letters, digits, '.', '_' or '-'"),
        description: z.string().optional().describe("Optional one-line description stored in package.json"),
      },
    },
    guarded(async ({ name, description }) => {
      assertProjectName(name);
      const dir = projectDir(name);
      await mkdir(dir, { recursive: true });
      const manifestPath = join(dir, "package.json");
      if (!existsSync(manifestPath)) {
        const manifest = {
          name,
          version: "0.0.0",
          private: true,
          type: "module",
          ...(description ? { description } : {}),
          hypit: { project: true },
        };
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const hadProfile = existsSync(join(dir, "hypit.runtime.json"));
      const init = hadProfile
        ? { output: "Kept the existing hypit.runtime.json (runtime init skipped)." }
        : await runProcess(process.execPath, [hypitLauncher, "runtime", "init"], { cwd: dir, timeoutSeconds: 120 });
      const notes = await adaptProfile(dir, {
        env: process.env,
        renderWorkers: config.renderWorkers,
        staging: { directory: config.stagingDir, baseUrl: `${config.publicBaseUrl ?? baseUrl}/staged` },
        jobLedgerPath: config.jobLedgerPath,
      });
      const profile = existsSync(join(dir, "hypit.runtime.json"))
        ? await readFile(join(dir, "hypit.runtime.json"), "utf8")
        : "(missing)";
      return text(
        [
          `Project "${name}" is ready at ${dir}.`,
          "",
          "runtime init output:",
          clip(init.output.trim(), 4000) || "(no output)",
          "",
          ...notes.map((note) => `- ${note}`),
          "",
          "hypit.runtime.json:",
          profile,
          "",
          "Next: author Sources with file_write, check them with hypit [check <source>], then build. Run `hypit runtime up --endpoint html.local --endpoint media.local` (background) once to prepare the render browser.",
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "hypit",
    {
      title: "Run the Hypit CLI",
      description:
        "Run `hypit <args...>` from a project's root on the server. Pass arguments as a list, e.g. [\"check\", \"productions/ad/authors/main.svml\"] or [\"build\", \"productions/ad/runs/main.svrun\"]. Add \"--json\" for machine-readable output. Use background=true for long work (runtime up, download prepare, build --follow) and poll job_status. Interactive prompts are not available.",
      inputSchema: {
        project: z.string().describe("Project name from project_list"),
        args: z.array(z.string()).min(1).describe("CLI arguments after `hypit`"),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Foreground timeout (default ${config.defaultTimeoutSeconds}, max ${config.maxTimeoutSeconds})`),
        background: z.boolean().optional().describe("Start as a background job and return its id immediately"),
      },
    },
    guarded(async ({ project, args, timeout_seconds, background }) => {
      const dir = existingProjectDir(project);
      const label = `hypit ${args.map(shellQuote).join(" ")}`;
      if (background) {
        const job = startJob({ label, project, cwd: dir, command: process.execPath, args: [hypitLauncher, ...args] });
        return json({ started: jobSummary(job), next: "Poll job_status with this id." });
      }
      if (args[0] === "studio") {
        throw new UserError("Studio keeps running until stopped; start it with background: true.");
      }
      const timeout = timeoutFor(timeout_seconds);
      const result = await runProcess(process.execPath, [hypitLauncher, ...args], { cwd: dir, timeoutSeconds: timeout });
      return formatProcess(label, result, timeout);
    }),
  );

  if (config.enableShell) {
    server.registerTool(
      "run_command",
      {
        title: "Run a shell command",
        description:
          "Run a bash command on the server, from a project's root (or the workspace root when project is omitted). Use it for npm/pnpm installs, building project component packages with tsc, ffmpeg/ffprobe, inspecting files, and anything the hypit tool does not cover. `hypit` is on PATH. Use background=true for long commands and poll job_status.",
        inputSchema: {
          command: z.string().min(1).describe("Bash command line"),
          project: z.string().optional().describe("Project to run in; omit for the workspace root"),
          timeout_seconds: z.number().int().positive().optional(),
          background: z.boolean().optional(),
        },
      },
      guarded(async ({ command, project, timeout_seconds, background }) => {
        await mkdir(config.workspace, { recursive: true });
        const dir = project ? existingProjectDir(project) : config.workspace;
        if (background) {
          const job = startJob({ label: command, project, cwd: dir, command: "bash", args: ["-lc", command] });
          return json({ started: jobSummary(job), next: "Poll job_status with this id." });
        }
        const timeout = timeoutFor(timeout_seconds);
        const result = await runProcess("bash", ["-lc", command], { cwd: dir, timeoutSeconds: timeout });
        return formatProcess(command, result, timeout);
      }),
    );
  }

  server.registerTool(
    "job_status",
    {
      title: "Check a background job",
      description: "Show a background job's state and the tail of its output. Omit job_id to list recent jobs.",
      inputSchema: {
        job_id: z.string().optional(),
        tail_lines: z.number().int().positive().max(5000).optional().describe("Output lines to return (default 80)"),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ job_id, tail_lines }) => {
      if (!job_id) return json({ jobs: listJobs().slice(0, 30).map(jobSummary) });
      const job = getJob(job_id);
      if (!job) throw new UserError(`No job ${job_id} in this server process (jobs reset when the server restarts).`);
      const log = readJobLog(job, tail_lines ?? 80);
      return text(`${JSON.stringify({ ...jobSummary(job), command: job.label, logBytes: log.bytes }, null, 2)}\n\n${log.text || "(no output yet)"}`);
    }),
  );

  server.registerTool(
    "job_stop",
    {
      title: "Stop a background job",
      description: "Terminate a running background job and its process group. A Hypit Build keeps running in the Worker; use `hypit cancel <build-id>` for that.",
      inputSchema: { job_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ job_id }) => {
      return stopJob(job_id) ? text(`Stopping ${job_id}.`) : failure(`${job_id} is not running.`);
    }),
  );

  server.registerTool(
    "file_list",
    {
      title: "List project files",
      description: "List files in a project directory with sizes and modification times. Directories end with '/'.",
      inputSchema: {
        project: z.string(),
        path: z.string().optional().describe("Directory relative to the project root (default '.')"),
        recursive: z.boolean().optional().describe("Descend into subdirectories, skipping node_modules (default false)"),
        max_entries: z.number().int().positive().max(5000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ project, path, recursive, max_entries }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new UserError(`Nothing at ${path ?? "."}.`);
      if (!info.isDirectory()) return text(`${toPosix(relative(root, target))}  ${formatBytes(info.size)}`);
      const max = max_entries ?? 500;
      const entries = await listTree(root, target, recursive ?? false, max);
      const more = entries.length >= max ? `\n… stopped at ${max} entries` : "";
      return text((entries.join("\n") || "(empty directory)") + more);
    }),
  );

  server.registerTool(
    "file_read",
    {
      title: "Read a project file",
      description:
        "Read a project file. Text comes back as text (use offset/limit for long files). PNG, JPEG, WebP and GIF come back as images so you can inspect frames and snapshots. Video, audio and other binary files return their size and a signed download link.",
      inputSchema: {
        project: z.string(),
        path: z.string(),
        offset: z.number().int().positive().optional().describe("First line, 1-based"),
        limit: z.number().int().positive().optional().describe("Maximum lines (default 2000)"),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ project, path, offset, limit }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new UserError(`No file at ${path}.`);
      if (info.isDirectory()) throw new UserError(`${path} is a directory; use file_list.`);
      const rel = toPosix(relative(root, target));
      const mime = IMAGE_TYPES[extname(target).toLowerCase()];
      if (mime && info.size <= config.maxInlineImageBytes) {
        const data = await readFile(target);
        return {
          content: [
            { type: "text", text: `${rel} (${formatBytes(info.size)})` },
            { type: "image", data: data.toString("base64"), mimeType: mime },
          ],
        };
      }
      if (!mime && (await isProbablyText(target))) {
        if (info.size > 20 * 1024 * 1024) throw new UserError(`${rel} is ${formatBytes(info.size)}; read it with run_command (head, sed, grep).`);
        return text(sliceLines(await readFile(target, "utf8"), offset, limit));
      }
      const link = signedFileUrl(baseUrl, "GET", project, rel, 3600);
      return json({
        path: rel,
        size: formatBytes(info.size),
        note: mime
          ? "Image is too large to inline; downscale it with ffmpeg or use the link."
          : "Binary file. Inspect media with `hypit media probe`, frames or tiles.",
        downloadUrl: link.url,
        expiresAt: link.expiresAt,
      });
    }),
  );

  server.registerTool(
    "file_write",
    {
      title: "Write a project file",
      description:
        "Create or overwrite a project file, creating parent directories. Use encoding 'base64' for small binary files. Set append=true to add to the end.",
      inputSchema: {
        project: z.string(),
        path: z.string(),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        append: z.boolean().optional(),
      },
    },
    guarded(async ({ project, path, content, encoding, append }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      const data = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
      await mkdir(dirname(target), { recursive: true });
      if (append) await appendFile(target, data);
      else await writeFile(target, data);
      return text(`${append ? "Appended" : "Wrote"} ${formatBytes(data.length)} to ${toPosix(relative(root, target))}.`);
    }),
  );

  server.registerTool(
    "file_delete",
    {
      title: "Delete a project file",
      description: "Delete a file, or a directory when recursive=true. Deleting the project root is refused.",
      inputSchema: { project: z.string(), path: z.string(), recursive: z.boolean().optional() },
      annotations: { destructiveHint: true },
    },
    guarded(async ({ project, path, recursive }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      if (target === root) throw new UserError("Refusing to delete the project root.");
      const info = await stat(target).catch(() => undefined);
      if (!info) throw new UserError(`Nothing at ${path}.`);
      if (info.isDirectory() && !recursive) throw new UserError(`${path} is a directory; pass recursive: true.`);
      await rm(target, { recursive: Boolean(recursive), force: false });
      return text(`Deleted ${toPosix(relative(root, target))}.`);
    }),
  );

  server.registerTool(
    "file_fetch",
    {
      title: "Download a URL into a project",
      description:
        "Download a direct http(s) file URL (mp4, mp3, png, zip...) into the project. For social video pages (TikTok, YouTube, Instagram, X) use `hypit download <url> --to <path>` instead.",
      inputSchema: {
        project: z.string(),
        url: z.string().url(),
        path: z.string().describe("Destination path relative to the project root"),
        overwrite: z.boolean().optional(),
      },
    },
    guarded(async ({ project, url, path, overwrite }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      if (!/^https?:\/\//i.test(url)) throw new UserError("Only http and https URLs are supported.");
      if (existsSync(target) && !overwrite) throw new UserError(`${path} exists; pass overwrite: true to replace it.`);
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new UserError(`Download failed: HTTP ${response.status} ${response.statusText}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > config.maxUploadBytes) throw new UserError(`File is ${formatBytes(declared)}, above the ${formatBytes(config.maxUploadBytes)} limit.`);
      await mkdir(dirname(target), { recursive: true });
      const temp = `${target}.part-${process.pid}`;
      let received = 0;
      const body = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > config.maxUploadBytes) body.destroy(new Error("File exceeds the upload size limit."));
      });
      try {
        await pipeline(body, createWriteStream(temp));
        await rename(temp, target);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return text(
        `Saved ${formatBytes(received)} from ${url} to ${toPosix(relative(root, target))} (${response.headers.get("content-type") ?? "unknown type"}).`,
      );
    }),
  );

  server.registerTool(
    "file_link",
    {
      title: "Make a download or upload link",
      description:
        "Create a time-limited signed URL for a project file. mode 'download' (default) lets the user open a rendered video or any file in a browser. mode 'upload' returns a URL and curl command the user can run to upload a file from their own computer to that path.",
      inputSchema: {
        project: z.string(),
        path: z.string(),
        mode: z.enum(["download", "upload"]).optional(),
        expires_minutes: z.number().int().positive().max(7 * 24 * 60).optional().describe("Default 60 for downloads, 30 for uploads"),
      },
      annotations: { readOnlyHint: true },
    },
    guarded(async ({ project, path, mode, expires_minutes }) => {
      const root = existingProjectDir(project);
      const target = resolveInside(root, path);
      const rel = toPosix(relative(root, target));
      if (!isInside(root, target) || rel === "") throw new UserError("Name a file inside the project.");
      if (mode === "upload") {
        const link = signedFileUrl(baseUrl, "PUT", project, rel, (expires_minutes ?? 30) * 60);
        return json({
          uploadUrl: link.url,
          expiresAt: link.expiresAt,
          maxSize: formatBytes(config.maxUploadBytes),
          curl: `curl --fail -T /path/to/local/file "${link.url}"`,
        });
      }
      const info = await stat(target).catch(() => undefined);
      if (!info || !info.isFile()) throw new UserError(`No file at ${rel}.`);
      const link = signedFileUrl(baseUrl, "GET", project, rel, (expires_minutes ?? 60) * 60);
      return json({ downloadUrl: link.url, expiresAt: link.expiresAt, size: formatBytes(info.size) });
    }),
  );
}
