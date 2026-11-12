import { createRequire } from "node:module";
import path from "node:path";
import { type Config, installedCliRoot } from "./config.js";
import {
  AppError,
  type Target,
  type Snapshot,
  type Source,
  type Comment,
  type Side,
} from "./types.js";
import { command, hash, now, safePath } from "./util.js";
import { diffLines } from "./diff.js";

export function parseTarget(value: string, config: Config): Target {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("invalid_url", "Provide a full MR or PR URL");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.port
  )
    throw new AppError("invalid_url", "Invalid source URL");
  if (u.hostname === "github.com") {
    const m = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(u.pathname);
    if (!m)
      throw new AppError("invalid_url", "Expected a GitHub pull request URL");
    return {
      provider: "github",
      host: u.hostname,
      repo: m[1],
      number: +m[2],
      url: `https://github.com/${m[1]}/pull/${+m[2]}`,
    };
  }
  if (!config.codebaseHosts.includes(u.hostname))
    throw new AppError(
      "source_host_not_allowed",
      "Add this company Codebase hostname with unfold config set codebaseHosts before importing",
      403,
    );
  const m =
    /^\/(.+)\/merge_requests\/(\d+)(?:\/(?:activity|changes|diff|commits|overview))?\/?$/.exec(
      u.pathname,
    );
  if (!m || !Number.isSafeInteger(+m[2]) || +m[2] < 1)
    throw new AppError(
      "invalid_url",
      "Expected a Codebase repository merge_requests/number URL",
    );
  const repo = safePath(m[1]);
  return {
    provider: "codebase",
    host: u.hostname,
    repo,
    number: +m[2],
    url: `${u.protocol}//${u.host}/${repo}/merge_requests/${+m[2]}`,
  };
}
export const identity = (t: Target) =>
  `${t.provider}:${t.host}:${t.repo.toLowerCase()}:${t.number}`;
export class Providers {
  constructor(readonly config: Config) {}
  async byted(args: string[]) {
    const result = JSON.parse(await command("bytedcli", ["--json", ...args]));
    if (result.status !== "success")
      throw new AppError(
        "source_error",
        result.error?.message || "Codebase request failed",
        502,
      );
    return result.data;
  }
  async snapshot(target: Target): Promise<Snapshot> {
    if (target.provider !== "codebase")
      throw new AppError(
        "provider_unavailable",
        "GitHub integration follows the Codebase vertical slice",
        503,
      );
    const args = ["-R", target.repo];
    const meta = await this.byted([
      "codebase",
      "mr",
      "get",
      target.url,
      ...args,
    ]);
    const v = meta.version;
    if (!v?.SourceCommitId || !(v.BaseCommitId || v.TargetCommitId))
      throw new AppError(
        "missing_revision",
        "The platform did not return an immutable commit range",
        502,
      );
    const [diff, discussions] = await Promise.all([
      this.byted([
        "codebase",
        "mr",
        "diff",
        String(target.number),
        ...args,
        "--version",
        String(v.Number),
        "--max-patch-bytes",
        "500000",
      ]),
      this.byted(["codebase", "mr", "comment", "list", target.url, ...args]),
    ]);
    const head = v.SourceCommitId,
      base = v.BaseCommitId || v.TargetCommitId;
    if (diff.range?.to !== head || diff.range?.from !== base)
      throw new AppError(
        "revision_changed",
        "The diff did not match the requested commit range",
        409,
      );
    return {
      id: hash(`${identity(target)}:${base}:${head}`).slice(0, 32),
      target,
      title: meta.merge_request.Title,
      description: meta.merge_request.Description || "",
      head,
      base,
      remoteVersion: String(v.Number),
      repoId: String(meta.repository.id),
      mrId: String(meta.merge_request.Id),
      fetchedAt: now(),
      files: diff.files.map((f: any) => {
        const patch = f.RawPatch || "",
          lines = diffLines(patch);
        return {
          path: f.ToPath || f.Path,
          oldPath: f.FromPath || f.Path,
          patch,
          binary: !!f.IsBinary,
          truncated: !!(f.Truncated || f.TooLarge),
          added: Math.max(
            f.LinesInserted || 0,
            lines.filter((l) => l.kind === "add").length,
          ),
          deleted: Math.max(
            f.LinesDeleted || 0,
            lines.filter((l) => l.kind === "delete").length,
          ),
        };
      }),
      comments: this.codebaseComments(discussions),
    };
  }
  codebaseComments(data: any): Comment[] {
    const comments: Comment[] = [];
    for (const t of data.threads || [])
      for (const c of t.Comments || []) {
        const p = c.Position || t.Positions?.[0];
        comments.push({
          id: String(c.Id),
          body: c.Content || "",
          author: c.CreatedBy?.Username || "",
          threadId: String(t.Id),
          path: p?.Path,
          side: p?.Side,
          line: p?.StartLine,
          outdated: !!t.Outdated,
        });
      }
    for (const c of data.review_notes || [])
      comments.push({
        id: String(c.Id),
        body: c.Content || "",
        author: c.Author?.Username || "",
      });
    return comments;
  }
  async source(s: Snapshot, filePath: string, side: Side): Promise<Source> {
    const p = safePath(filePath),
      commit = side === "old" ? s.base : s.head;
    const d = await this.byted([
      "codebase",
      "repo",
      "file",
      p,
      "-R",
      s.target.repo,
      "--revision",
      commit,
    ]);
    const f = d.file;
    if (
      !f ||
      f.IsBinary ||
      f.IsLfs ||
      f.Symlink ||
      f.Submodule ||
      f.Type === "symlink" ||
      f.Type === "directory" ||
      f.Truncated ||
      f.TooLarge ||
      f.Size > 1024 * 1024
    )
      throw new AppError(
        "source_unavailable",
        "File is binary, indirect, truncated, too large, or not a regular file",
        422,
      );
    const content =
      f.Encoding === "base64"
        ? Buffer.from(f.Content || "", "base64").toString("utf8")
        : f.Content || "";
    if (Buffer.byteLength(content) > 1024 * 1024 || content.includes("\0"))
      throw new AppError(
        "source_unavailable",
        "Only regular text files up to 1 MB are supported",
        422,
      );
    return {
      id: hash(`${s.id}:${side}:${p}`).slice(0, 32),
      versionId: s.id,
      path: p,
      side,
      commit,
      content,
    };
  }
  async tree(s: Snapshot, directory: string, side: Side) {
    const p = directory === "." ? "." : safePath(directory);
    const d = await this.byted([
      "codebase",
      "repo",
      "file",
      p,
      "-R",
      s.target.repo,
      "--revision",
      side === "old" ? s.base : s.head,
    ]);
    return (d.file?.DirEntries || []).map((x: any) => ({
      path: x.Path,
      name: x.Name || path.posix.basename(x.Path || ""),
      type: x.Type,
      size: x.Size,
    }));
  }
  async publish(
    s: Snapshot,
    body: string,
    anchor?: { path: string; side: Side; start: number; end: number },
  ): Promise<{ id: string }> {
    // Use the installed CLI's own request/authentication stack without copying it.
    // Its high-level comment command re-resolves latest HEAD, so pin Position here.
    const require = createRequire(import.meta.url);
    const api = require(path.join(installedCliRoot(), "api/codebase/index.js"));
    const result = await api.createComment({
      CommentableType: "merge_request",
      CommentableId: s.mrId,
      RepoId: s.repoId,
      Content: body,
      ...(anchor
        ? {
            Position: {
              Type: "content",
              Side: anchor.side,
              OldCommitId: s.base,
              NewCommitId: s.head,
              Path: anchor.path,
              StartLine: anchor.start,
              EndLine: anchor.end,
              StartColumn: 1,
              EndColumn: 1000,
            },
          }
        : {}),
    });
    if (!result.Comment?.Id)
      throw new AppError(
        "publish_unknown",
        "Platform did not return a comment ID",
        502,
      );
    return { id: String(result.Comment.Id) };
  }
}
