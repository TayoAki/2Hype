import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

/** Environment shared by every child: plain text output and the Distribution's launcher on PATH. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PATH: `${config.hypitHome}:${process.env.PATH ?? ""}`,
    ...extra,
  };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Keep the head and the tail of long output; errors usually sit at the end. */
export function clip(text: string, max = config.maxOutputChars): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n… [${dropped} characters omitted] …\n\n${text.slice(-tail)}`;
}

/**
 * Run a command in its own process group, merging stdout and stderr in arrival order. On timeout the
 * whole group is terminated. Processes that detach into their own session (the Hypit Worker) survive.
 */
export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; timeoutSeconds: number; env?: Record<string, string> },
): Promise<ProcessResult> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnv(options.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const chunks: string[] = [];
    let size = 0;
    const cap = config.maxOutputChars * 20;
    const collect = (data: Buffer) => {
      if (size > cap) return;
      const text = data.toString("utf8");
      size += text.length;
      chunks.push(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      setTimeout(() => killGroup(child.pid, "SIGKILL"), 5000).unref();
    }, options.timeoutSeconds * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        output: chunks.join(""),
      });
    });
  });
}

export interface Job {
  id: string;
  label: string;
  project?: string;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  logPath: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

const jobs = new Map<string, Job>();

export function startJob(input: {
  label: string;
  project?: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Job {
  mkdirSync(config.jobsDir, { recursive: true });
  const id = `job_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
  const logPath = join(config.jobsDir, `${id}.log`);
  const fd = openSync(logPath, "a");
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: childEnv(input.env),
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  closeSync(fd);
  const job: Job = {
    id,
    label: input.label,
    project: input.project,
    cwd: input.cwd,
    command: input.command,
    args: input.args,
    pid: child.pid,
    logPath,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  child.on("error", (error) => {
    job.endedAt = new Date().toISOString();
    job.exitCode = -1;
    try {
      appendFileSync(logPath, `\n[hypit-mcp] failed to start: ${error.message}\n`);
    } catch {
      /* ignore */
    }
  });
  child.on("exit", (exitCode, signal) => {
    job.endedAt = new Date().toISOString();
    job.exitCode = exitCode;
    job.signal = signal;
  });
  child.unref();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function stopJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.endedAt) return false;
  killGroup(job.pid, "SIGTERM");
  setTimeout(() => {
    if (!job.endedAt) killGroup(job.pid, "SIGKILL");
  }, 5000).unref();
  return true;
}

export function readJobLog(job: Job, tailLines: number): { text: string; bytes: number } {
  let bytes = 0;
  try {
    bytes = statSync(job.logPath).size;
  } catch {
    return { text: "", bytes };
  }
  const maxBytes = 2 * 1024 * 1024;
  const buffer = readFileSync(job.logPath);
  const slice = buffer.length > maxBytes ? buffer.subarray(buffer.length - maxBytes) : buffer;
  const lines = slice.toString("utf8").split("\n");
  return { text: clip(lines.slice(-tailLines).join("\n")), bytes };
}

export function jobSummary(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    label: job.label,
    project: job.project,
    state: job.endedAt ? (job.exitCode === 0 ? "succeeded" : "failed") : "running",
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
  };
}
