import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { AppError } from "./types.js";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const hash = (s: unknown) =>
  createHash("sha256")
    .update(typeof s === "string" ? s : JSON.stringify(s))
    .digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function safePath(s: string) {
  if (
    !s ||
    s.startsWith("-") ||
    s.length > 2048 ||
    s.includes("\0") ||
    s.includes("\\") ||
    path.posix.isAbsolute(s) ||
    s.split("/").some((p) => p === ".." || p === ".git" || p === "")
  )
    throw new AppError(
      "invalid_path",
      "Use a repository-relative path without traversal or .git",
    );
  return s;
}
export async function command(
  exe: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
  } = {},
) {
  return new Promise<string>((resolve, reject) =>
    execFile(
      exe,
      args,
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new AppError(
              "connector_command_failed",
              `${path.basename(exe)} failed: ${String(stderr || error.message).slice(0, 1200)}`,
              502,
            ),
          );
        else resolve(stdout);
      },
    ),
  );
}
export function jsonObject(text: string) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    throw new AppError(
      "invalid_agent_output",
      "The backend did not return the requested structured result",
      502,
    );
  }
}
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
