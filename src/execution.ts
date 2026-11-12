import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Providers } from "./providers.js";
import { AppError, type ExecutionRequest, type Snapshot } from "./types.js";
import { safePath, id } from "./util.js";

export async function executeApproved(
  root: string,
  providers: Providers,
  snapshot: Snapshot,
  request: ExecutionRequest,
  signal: AbortSignal,
) {
  if (request.cwd !== ".") safePath(request.cwd);
  if (
    request.timeoutSeconds < 1 ||
    request.timeoutSeconds > 600 ||
    request.command.length > 16000
  )
    throw new AppError(
      "invalid_execution",
      "Command timeout must be 1–600 seconds and command length at most 16000",
    );
  const work = path.join(root, "executions", id());
  await mkdir(work, { recursive: true, mode: 0o700 });
  let count = 0,
    bytes = 0;
  const materialize = async (dir: string) => {
    for (const item of await providers.tree(snapshot, dir, "new")) {
      if (signal.aborted) throw signal.reason;
      const p = safePath(item.path);
      if (++count > 10000)
        throw new AppError(
          "snapshot_too_large",
          "Execution snapshot exceeds 10000 entries",
        );
      if (item.type === "directory" || item.type === "tree") {
        await mkdir(path.join(work, p), { recursive: true });
        await materialize(p);
      } else {
        const source = await providers.source(snapshot, p, "new");
        bytes += Buffer.byteLength(source.content);
        if (bytes > 100 * 1024 * 1024)
          throw new AppError(
            "snapshot_too_large",
            "Execution snapshot exceeds 100 MB",
          );
        await mkdir(path.dirname(path.join(work, p)), { recursive: true });
        await writeFile(path.join(work, p), source.content);
      }
    }
  };
  try {
    await materialize(".");
    await mkdir(path.join(work, ".unfold-tmp"), { recursive: true });
    const args = [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/home",
      "--dir",
      "/home/worker",
      "--bind",
      work,
      "/workspace",
      "--chdir",
      path.posix.join("/workspace", request.cwd),
      "--clearenv",
      "--setenv",
      "PATH",
      "/usr/bin:/bin",
      "--setenv",
      "HOME",
      "/home/worker",
      "--setenv",
      "LANG",
      "C.UTF-8",
    ];
    if (request.network)
      args.push(
        "--share-net",
        "--ro-bind",
        "/etc/resolv.conf",
        "/etc/resolv.conf",
        "--ro-bind",
        "/etc/ssl/certs",
        "/etc/ssl/certs",
      );
    args.push("/bin/sh", "-c", request.command);
    return await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn("bwrap", args, {
        env: { PATH: process.env.PATH },
        signal,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "",
        stderr = "",
        timedOut = false;
      const kill = () => {
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutSeconds * 1000);
      const abort = () => kill();
      signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (b) => {
        stdout = (stdout + b).slice(-128000);
      });
      child.stderr.on("data", (b) => {
        stderr = (stderr + b).slice(-128000);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve({ exitCode: code, stdout, stderr, timedOut });
      });
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
