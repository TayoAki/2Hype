import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "./config.js";

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class UserError extends Error {}

export function assertProjectName(name: string): string {
  if (!PROJECT_NAME.test(name)) {
    throw new UserError(
      `Invalid project name "${name}". Use 1-64 lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`,
    );
  }
  return name;
}

export function projectDir(name: string): string {
  return join(config.workspace, assertProjectName(name));
}

export function existingProjectDir(name: string): string {
  const dir = projectDir(name);
  if (!existsSync(join(dir, "package.json"))) {
    throw new UserError(`Project "${name}" does not exist. Create it with project_create or check project_list.`);
  }
  return dir;
}

/** True when `child` is `root` or lies inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a user-supplied relative path inside `root`, refusing `..` escapes and symlinks that
 * point outside. The path does not need to exist.
 */
export function resolveInside(root: string, userPath: string | undefined): string {
  const cleaned = (userPath ?? ".").trim() || ".";
  if (isAbsolute(cleaned)) throw new UserError(`Use a path relative to the project, not "${cleaned}".`);
  const target = resolve(root, cleaned);
  if (!isInside(root, target)) throw new UserError(`Path "${cleaned}" leaves the project directory.`);
  let probe = target;
  while (!existsSync(probe) && isInside(root, probe) && probe !== root) probe = resolve(probe, "..");
  if (existsSync(probe)) {
    const realRoot = existsSync(root) ? realpathSync(root) : root;
    if (!isInside(realRoot, realpathSync(probe))) {
      throw new UserError(`Path "${cleaned}" resolves through a link outside the project directory.`);
    }
  }
  return target;
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}
