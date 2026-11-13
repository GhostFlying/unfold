import { TextDecoder } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  AppError,
  type Comment,
  type Side,
  type Snapshot,
  type Source,
  type Target,
  type Ownership,
} from "./types.js";
import { command, hash, now, safePath } from "./util.js";
import { diffLines, validateAnchor } from "./diff.js";
import { codeownersRules, unavailableOwnership } from "./ownership-rules.js";

const shaPattern = /^[a-f0-9]{40}$/;
const maxFiles = 300;
const maxSourceBytes = 1024 * 1024;
type Anchor = { path: string; side: Side; start: number; end: number };
type TreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
};
export type GhRunner = (args: string[], input?: string) => Promise<string>;

export function githubTarget(repo: string, number: number): Target {
  if (
    !/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_.-]{1,100}$/i.test(repo) ||
    [".", "..", ".git"].includes(repo.split("/")[1].toLowerCase()) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new AppError(
      "invalid_url",
      "Expected a GitHub owner/repository/pull/number URL",
    );
  return {
    provider: "github",
    host: "github.com",
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
  };
}

async function runGh(args: string[], input?: string) {
  const env = {
    ...process.env,
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GH_PAGER: "cat",
  };
  delete (env as NodeJS.ProcessEnv).GH_DEBUG;
  return command("gh", args, { input, env });
}

export class GitHub {
  private trees = new Map<string, Promise<TreeEntry[]>>();
  constructor(private readonly run: GhRunner = runGh) {}

  private repo(t: Target) {
    if (t.host !== "github.com" || t.provider !== "github")
      throw new AppError(
        "source_host_not_allowed",
        "Only github.com is supported by the GitHub adapter",
        403,
      );
    return githubTarget(t.repo, t.number).repo;
  }

  async api(endpoint: string, body?: object): Promise<any> {
    let result: string;
    try {
      const args = [
        "api",
        "--hostname",
        "github.com",
        "--method",
        body ? "POST" : "GET",
        "--header",
        "Accept: application/vnd.github+json",
        "--header",
        "X-GitHub-Api-Version: 2022-11-28",
        endpoint,
        ...(body ? ["--input", "-"] : []),
      ];
      for (let attempt = 0; ; attempt++) {
        try {
          result = await this.run(
            args,
            body ? JSON.stringify(body) : undefined,
          );
          break;
        } catch (error: any) {
          // Only explicit temporary HTTP failures on reads are retryable.
          // A failed POST may already exist remotely and must be reconciled.
          if (
            body ||
            attempt >= 2 ||
            !/HTTP (?:502|503|504)\b/i.test(String(error.message))
          )
            throw error;
          await delay(attempt === 0 ? 250 : 750);
        }
      }
    } catch (e: any) {
      const message = String(e.message || e);
      if (
        /HTTP 401|not logged|gh auth login|authentication required|GH_TOKEN environment/i.test(
          message,
        )
      )
        throw new AppError(
          "github_auth_required",
          "GitHub authentication is unavailable. Run gh auth login --hostname github.com on the connector host.",
          401,
        );
      if (/HTTP 403|HTTP 429/i.test(message))
        throw new AppError(
          "github_access_denied",
          "GitHub denied access or rate-limited this request. Check repository permissions and gh API rate limits on the connector host.",
          403,
        );
      if (/HTTP 404/i.test(message))
        throw new AppError(
          "github_not_found",
          "GitHub could not find this resource with the connector's current gh account.",
          404,
        );
      if (/HTTP 422/i.test(message))
        throw new AppError(
          "github_validation_failed",
          "GitHub rejected the requested revision or comment position. Refresh and check the exact draft before proceeding.",
          422,
        );
      throw new AppError(
        "github_request_failed",
        `GitHub gh request failed: ${message.slice(0, 1200)}`,
        502,
      );
    }
    try {
      return JSON.parse(result);
    } catch {
      throw new AppError(
        "github_invalid_response",
        "gh did not return a complete JSON response",
        502,
      );
    }
  }

  async diagnose() {
    try {
      const [version, account] = await Promise.all([
        this.run(["--version"]),
        this.api("user"),
      ]);
      return {
        available: true,
        authenticated: true,
        version: version.split("\n")[0],
        account: String(account.login),
      };
    } catch (e: any) {
      return {
        available: false,
        authenticated: false,
        error: { code: e.code || "github_request_failed", message: e.message },
      };
    }
  }

  private async pages(endpoint: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await this.api(`${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(rows) || rows.length > 100)
        throw new AppError(
          "github_invalid_response",
          "GitHub returned an invalid discussion page",
          502,
        );
      result.push(...rows);
      if (rows.length < 100) return result;
    }
    throw new AppError(
      "github_discussion_limit",
      "Discussion exceeds the 10,000-item read limit; no partial discussion was saved",
      422,
    );
  }

  private async comments(prefix: string): Promise<Comment[]> {
    const [ordinary, inline, reviews] = await Promise.all([
      this.pages(prefix.replace(/\/pulls\/(\d+)$/, "/issues/$1") + "/comments"),
      this.pages(prefix + "/comments"),
      this.pages(prefix + "/reviews"),
    ]);
    const submitted = new Set(
      reviews.filter((r) => r.state !== "PENDING").map((r) => r.id),
    );
    const comments: Comment[] = ordinary.map((c) => ({
      id: `issue:${c.id}`,
      body: c.body || "",
      author: c.user?.login || "",
      url: c.html_url,
    }));
    for (const c of reviews) {
      if (c.state === "PENDING" || !c.body) continue;
      comments.push({
        id: `review:${c.id}`,
        body: c.body,
        author: c.user?.login || "",
        url: c.html_url,
      });
    }
    for (const c of inline) {
      if (!submitted.has(c.pull_request_review_id)) continue;
      comments.push({
        id: `inline:${c.id}`,
        body: c.body || "",
        author: c.user?.login || "",
        threadId: `inline:${c.in_reply_to_id || c.id}`,
        path: c.path,
        side: c.side === "LEFT" ? "old" : "new",
        line:
          c.start_line ??
          c.line ??
          c.original_start_line ??
          c.original_line ??
          undefined,
        outdated: c.line == null,
        url: c.html_url,
      });
    }
    return comments;
  }

  async snapshot(target: Target): Promise<Snapshot> {
    const repo = this.repo(target),
      prefix = `repos/${repo}/pulls/${target.number}`;
    const meta = await this.api(prefix);
    const head = meta.head?.sha,
      tip = meta.base?.sha;
    if (
      !shaPattern.test(head || "") ||
      !shaPattern.test(tip || "") ||
      meta.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
    )
      throw new AppError(
        "missing_revision",
        "GitHub did not return a valid immutable PR range",
        502,
      );
    if (!Number.isSafeInteger(meta.changed_files) || meta.changed_files < 0)
      throw new AppError(
        "github_invalid_response",
        "GitHub did not return the complete changed-file count",
        502,
      );
    if (meta.changed_files > maxFiles)
      throw new AppError(
        "github_diff_limit",
        "GitHub compare supports at most 300 changed files; this PR cannot be imported completely",
        422,
      );
    const [comparison, comments] = await Promise.all([
      this.api(`repos/${repo}/compare/${tip}...${head}?per_page=1`),
      this.comments(prefix),
    ]);
    const base = comparison.merge_base_commit?.sha;
    if (
      !shaPattern.test(base || "") ||
      comparison.base_commit?.sha !== tip ||
      !Array.isArray(comparison.files)
    )
      throw new AppError(
        "missing_revision",
        "GitHub comparison did not match the requested immutable range",
        502,
      );
    const latest = await this.api(prefix);
    if (
      latest.head?.sha !== head ||
      latest.base?.sha !== tip ||
      latest.changed_files !== meta.changed_files
    )
      throw new AppError(
        "revision_changed",
        "The PR changed during import. Refresh before continuing.",
        409,
      );
    if (
      comparison.files.length !== meta.changed_files ||
      comparison.files.length > maxFiles
    )
      throw new AppError(
        "github_diff_incomplete",
        "GitHub returned an incomplete or different PR comparison; no partial snapshot was saved",
        422,
      );
    const files = comparison.files.map((f: any) => {
      const filePath = safePath(f.filename),
        oldPath = safePath(f.previous_filename || f.filename);
      const patch = typeof f.patch === "string" ? f.patch : "";
      const lines = diffLines(patch);
      const complete =
        lines.filter((l) => l.kind === "add").length === f.additions &&
        lines.filter((l) => l.kind === "delete").length === f.deletions;
      return {
        path: filePath,
        oldPath,
        patch,
        binary: false,
        // Missing patches can mean binary, oversized text or a pure rename.
        // Never infer readable text or an inline position from missing evidence.
        truncated: !complete || (!patch && f.status !== "renamed"),
        added: f.additions,
        deleted: f.deletions,
      };
    });
    if (new Set(files.map((f: any) => f.path)).size !== files.length)
      throw new AppError(
        "github_invalid_response",
        "GitHub comparison contains duplicate paths",
        502,
      );
    return {
      id: hash(
        `github:github.com:${repo.toLowerCase()}:${target.number}:${base}:${head}`,
      ).slice(0, 32),
      target: githubTarget(repo, target.number),
      title: meta.title,
      description: meta.body || "",
      head,
      base,
      targetHead: tip,
      remoteVersion: head.slice(0, 12),
      repoId: String(meta.base.repo.id),
      mrId: String(meta.id),
      fetchedAt: now(),
      files,
      comments,
    };
  }

  private async entries(repo: string, sha: string): Promise<TreeEntry[]> {
    if (!shaPattern.test(sha))
      throw new AppError("missing_revision", "Invalid pinned Git object", 422);
    const key = `${repo.toLowerCase()}:${sha}`;
    let pending = this.trees.get(key);
    if (!pending) {
      pending = this.api(`repos/${repo}/git/trees/${sha}`).then((data) => {
        if (
          data.truncated ||
          !Array.isArray(data.tree) ||
          data.tree.length > 10_000
        )
          throw new AppError(
            "source_unavailable",
            "GitHub directory listing is incomplete or too large",
            422,
          );
        for (const e of data.tree)
          if (
            safePath(e.path) !== e.path ||
            e.path.includes("/") ||
            e.path === "." ||
            !shaPattern.test(e.sha)
          )
            throw new AppError(
              "source_unavailable",
              "GitHub returned an invalid Git tree entry",
              422,
            );
        return data.tree;
      });
      this.trees.set(key, pending);
      if (this.trees.size > 256)
        this.trees.delete(this.trees.keys().next().value!);
      void pending.catch(() => {
        if (this.trees.get(key) === pending) this.trees.delete(key);
      });
    }
    return pending;
  }
  async ownership(s: Snapshot): Promise<Ownership> {
    try {
      let targetHead = s.targetHead;
      if (!targetHead) {
        // Older snapshots stored only the merge base. Recover current rules only
        // when the live PR still has this exact reviewed comparison; never edit
        // the immutable snapshot or attach current rules to a different version.
        const repo = this.repo(s.target),
          prefix = `repos/${repo}/pulls/${s.target.number}`;
        const meta = await this.api(prefix);
        if (meta.head?.sha !== s.head || !shaPattern.test(meta.base?.sha || ""))
          throw new AppError(
            "revision_changed",
            "Cannot recover historical target rules",
            409,
          );
        targetHead = meta.base.sha;
        const comparison = await this.api(
          `repos/${repo}/compare/${targetHead}...${s.head}?per_page=1`,
        );
        const latest = await this.api(prefix);
        if (
          comparison.merge_base_commit?.sha !== s.base ||
          comparison.base_commit?.sha !== targetHead ||
          latest.head?.sha !== s.head ||
          latest.base?.sha !== targetHead
        )
          throw new AppError(
            "revision_changed",
            "The PR changed while capturing rules",
            409,
          );
      }
      if (!shaPattern.test(targetHead!))
        throw new AppError("missing_revision", "Invalid target tip", 422);
      const target = { ...s, head: targetHead! };
      let content: string | undefined,
        file = "";
      for (const candidate of [
        ".github/CODEOWNERS",
        "CODEOWNERS",
        "docs/CODEOWNERS",
      ]) {
        try {
          content = (await this.source(target, candidate, "new")).content;
          file = candidate;
          break;
        } catch (e: any) {
          if (e.code !== "source_not_found") throw e;
        }
      }
      const parsed =
        content === undefined
          ? undefined
          : codeownersRules(content, file, targetHead!);
      const result: Ownership = {
        versionId: s.id,
        provider: "github",
        capturedAt: now(),
        status: "complete",
        rules: parsed?.rules || [],
        files: [],
        warnings: parsed?.warnings.slice(0, 32) || [],
      };
      for (const f of s.files)
        for (const side of ["old", "new"] as const) {
          const p = side === "old" ? f.oldPath : f.path,
            rule = parsed?.match(p);
          result.files.push({
            path: p,
            side,
            owners: rule?.owners || [],
            ruleIds: rule ? [rule.id] : [],
            status: rule?.owners.length ? "resolved" : "unowned",
          });
        }
      return result;
    } catch {
      return unavailableOwnership(
        s,
        "Pinned GitHub CODEOWNERS could not be read; path-based review is available",
      );
    }
  }

  private async locate(
    s: Snapshot,
    filePath: string,
    side: Side,
  ): Promise<TreeEntry> {
    const repo = this.repo(s.target),
      segments = safePath(filePath).split("/");
    let sha = side === "old" ? s.base : s.head;
    for (let i = 0; i < segments.length; i++) {
      const entry = (await this.entries(repo, sha)).find(
        (e) => e.path === segments[i],
      );
      if (!entry)
        throw new AppError(
          "source_not_found",
          "Path does not exist at this pinned commit",
          404,
        );
      if (i === segments.length - 1) return entry;
      if (entry.type !== "tree" || entry.mode !== "040000")
        throw new AppError(
          "source_unavailable",
          "Cannot traverse a symlink, submodule or regular file",
          422,
        );
      sha = entry.sha;
    }
    throw new AppError(
      "invalid_path",
      "Expected a repository-relative file path",
    );
  }

  async tree(s: Snapshot, directory: string, side: Side) {
    const repo = this.repo(s.target);
    let sha = side === "old" ? s.base : s.head;
    if (directory !== ".") {
      const entry = await this.locate(s, directory, side);
      if (entry.type !== "tree" || entry.mode !== "040000")
        throw new AppError(
          "source_unavailable",
          "Path is not a regular directory",
          422,
        );
      sha = entry.sha;
    }
    return (await this.entries(repo, sha)).map((e) => ({
      path: directory === "." ? e.path : `${directory}/${e.path}`,
      name: e.path,
      size: e.size,
      type:
        e.mode === "040000" && e.type === "tree"
          ? "directory"
          : ["100644", "100755"].includes(e.mode) && e.type === "blob"
            ? "file"
            : e.mode === "120000"
              ? "symlink"
              : e.mode === "160000"
                ? "submodule"
                : "unsupported",
    }));
  }

  async source(s: Snapshot, filePath: string, side: Side): Promise<Source> {
    const p = safePath(filePath),
      repo = this.repo(s.target),
      entry = await this.locate(s, p, side);
    if (
      entry.type !== "blob" ||
      !["100644", "100755"].includes(entry.mode) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size! > maxSourceBytes
    )
      throw new AppError(
        "source_unavailable",
        "Only regular files up to 1 MB are supported",
        422,
      );
    const blob = await this.api(`repos/${repo}/git/blobs/${entry.sha}`);
    if (
      blob.sha !== entry.sha ||
      blob.encoding !== "base64" ||
      blob.size !== entry.size ||
      typeof blob.content !== "string"
    )
      throw new AppError(
        "source_unavailable",
        "GitHub did not return the requested complete blob",
        422,
      );
    const bytes = Buffer.from(blob.content, "base64");
    if (bytes.length !== entry.size || bytes.includes(0))
      throw new AppError(
        "source_unavailable",
        "Binary or incomplete source is unavailable",
        422,
      );
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError(
        "source_unavailable",
        "Only UTF-8 source text is supported",
        422,
      );
    }
    if (content.startsWith("version https://git-lfs.github.com/spec/v1"))
      throw new AppError(
        "source_unavailable",
        "LFS pointers are not source evidence",
        422,
      );
    return {
      id: hash(`${s.id}:${side}:${p}`).slice(0, 32),
      versionId: s.id,
      path: p,
      side,
      commit: side === "old" ? s.base : s.head,
      content,
    };
  }

  async publish(
    s: Snapshot,
    body: string,
    anchor?: Anchor,
  ): Promise<{ id: string }> {
    const repo = this.repo(s.target);
    let payload: object = { body },
      kind = "issue",
      resource = `issues/${s.target.number}`;
    if (anchor) {
      if (
        !["old", "new"].includes(anchor.side) ||
        !Number.isSafeInteger(anchor.start) ||
        !Number.isSafeInteger(anchor.end) ||
        anchor.start < 1 ||
        anchor.end < anchor.start ||
        anchor.end - anchor.start > 500
      )
        throw new AppError(
          "unmappable_anchor",
          "Invalid inline comment range",
          409,
        );
      validateAnchor(s, {
        ...anchor,
        id: "",
        sourceId: "",
        commit: anchor.side === "old" ? s.base : s.head,
      });
      const file = s.files.find(
        (f) => (anchor.side === "old" ? f.oldPath : f.path) === anchor.path,
      )!;
      const side = anchor.side === "old" ? "LEFT" : "RIGHT";
      payload = {
        body,
        commit_id: s.head,
        path: file.path,
        side,
        line: anchor.end,
        ...(anchor.start !== anchor.end
          ? { start_line: anchor.start, start_side: side }
          : {}),
      };
      kind = "inline";
      resource = `pulls/${s.target.number}`;
    }
    const comment = await this.api(
      `repos/${repo}/${resource}/comments`,
      payload,
    );
    if (!Number.isSafeInteger(comment.id) || comment.id < 1)
      throw new AppError(
        "publish_unknown",
        "GitHub did not return a comment ID; reconcile before retrying",
        502,
      );
    return { id: `${kind}:${comment.id}` };
  }
}
