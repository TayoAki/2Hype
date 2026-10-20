import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export type LinkMethod = "GET" | "PUT";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison that also hides length differences. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function signature(method: LinkMethod, project: string, path: string, expires: number): string {
  return createHmac("sha256", config.signingSecret)
    .update(`${method}\n${project}\n${path}\n${expires}`)
    .digest("hex");
}

export function encodePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

export function signedFileUrl(
  baseUrl: string,
  method: LinkMethod,
  project: string,
  path: string,
  expiresInSeconds: number,
): { url: string; expiresAt: string } {
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = signature(method, project, path, expires);
  const url = `${baseUrl}/files/${encodeURIComponent(project)}/${encodePath(path)}?exp=${expires}&sig=${sig}`;
  return { url, expiresAt: new Date(expires * 1000).toISOString() };
}

export function verifySignature(
  method: LinkMethod,
  project: string,
  path: string,
  expires: string | undefined,
  sig: string | undefined,
): boolean {
  if (!config.signingSecret || !expires || !sig) return false;
  const exp = Number(expires);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature(method, project, path, exp), sig);
}
