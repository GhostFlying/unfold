import test from "node:test";
import assert from "node:assert/strict";
import { GitHub, githubTarget, type GhRunner } from "../src/github.js";
import { Providers, parseTarget } from "../src/providers.js";
import { command } from "../src/util.js";
import { AppError, type Snapshot } from "../src/types.js";
import { fixture } from "./fixtures.js";

const head = "a".repeat(40),
  tip = "b".repeat(40),
  base = "c".repeat(40);
const dir = "d".repeat(40),
  blobSha = "e".repeat(40);
const target = githubTarget("example/repo", 42);
const text = "export function queue() {\n  return 1;\n}\n";
const patch =
  "@@ -1,3 +1,3 @@\n export function queue() {\n-  return 0;\n+  return 1;\n }";
function ghFixture(repo = "example/repo") {
  const target = githubTarget(repo, 42);
  const calls: { args: string[]; endpoint?: string; body?: any }[] = [];
  const meta = {
    id: 42,
    title: "Make return value explicit",
    body: "A fork PR",
    changed_files: 1,
    base: { sha: tip, repo: { id: 123, full_name: target.repo } },
    head: { sha: head, repo: { full_name: "contributor/repo" } },
  };
  const comparison = {
    base_commit: { sha: tip },
    merge_base_commit: { sha: base },
    files: [
      {
        filename: "src/new.ts",
        previous_filename: "src/old.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch,
      },
    ],
  };
  const ordinary: any[] = [];
  const reviews: any[] = [{ id: 10, state: "COMMENTED", body: "" }];
  const inline: any[] = [];
  const responses = new Map<string, any>([
    [`repos/${target.repo}/pulls/42`, meta],
    [`repos/${target.repo}/compare/${tip}...${head}?per_page=1`, comparison],
    [
      `repos/${target.repo}/git/trees/${head}`,
      { tree: [{ path: "src", sha: dir, type: "tree", mode: "040000" }] },
    ],
    [
      `repos/${target.repo}/git/trees/${base}`,
      { tree: [{ path: "src", sha: dir, type: "tree", mode: "040000" }] },
    ],
    [
      `repos/${target.repo}/git/trees/${dir}`,
      {
        tree: [
          {
            path: "new.ts",
            sha: blobSha,
            type: "blob",
            mode: "100644",
            size: Buffer.byteLength(text),
          },
          {
            path: "old.ts",
            sha: blobSha,
            type: "blob",
            mode: "100755",
            size: Buffer.byteLength(text),
          },
          {
            path: "secret",
            sha: blobSha,
            type: "blob",
            mode: "120000",
            size: 4,
          },
          { path: "module", sha: blobSha, type: "commit", mode: "160000" },
        ],
      },
    ],
    [
      `repos/${target.repo}/git/blobs/${blobSha}`,
      {
        sha: blobSha,
        size: Buffer.byteLength(text),
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      },
    ],
  ]);
  let afterWriteFailure = false;
  let metaReads = 0;
  let onMetaRead: ((count: number) => void) | undefined;
  const runner: GhRunner = async (args, input) => {
    const endpoint = args.find((a) => a.startsWith("repos/") || a === "user");
    const body = input ? JSON.parse(input) : undefined;
    calls.push({ args, endpoint, body });
    if (args[0] === "--version")
      return "gh version test\nhttps://github.com/cli/cli";
    if (endpoint === "user") return JSON.stringify({ login: "test-owner" });
    assert.ok(endpoint);
    if (body) {
      const comment = {
        id: 987,
        body: body.body,
        user: { login: "test-owner" },
        pull_request_review_id: 10,
        path: body.path,
        line: body.line,
        side: body.side,
      };
      (endpoint.includes("/issues/") ? ordinary : inline).push(comment);
      if (afterWriteFailure)
        throw new Error("socket closed after GitHub accepted the comment");
      return JSON.stringify(comment);
    }
    if (endpoint === `repos/${target.repo}/pulls/42`) onMetaRead?.(++metaReads);
    const page = /\?per_page=100&page=(\d+)$/.exec(endpoint);
    if (page) {
      const rows = endpoint.includes("/reviews?")
        ? reviews
        : endpoint.includes("/issues/")
          ? ordinary
          : inline;
      return JSON.stringify(rows.slice((+page[1] - 1) * 100, +page[1] * 100));
    }
    assert.ok(responses.has(endpoint), `Unexpected gh API call: ${endpoint}`);
    return JSON.stringify(responses.get(endpoint));
  };
  return {
    gh: new GitHub(runner),
    calls,
    meta,
    comparison,
    ordinary,
    reviews,
    inline,
    responses,
    failAfterWrite: () => {
      afterWriteFailure = true;
    },
    onMeta: (fn: (count: number) => void) => {
      onMetaRead = fn;
    },
  };
}
const code = (expected: string) => (e: any) =>
  e instanceof AppError && e.code === expected;

test("GitHub URL validation and provider dispatch preserve canonical PR identity", async () => {
  const f = fixture(),
    g = ghFixture();
  try {
    const providers = new Providers(f.service.config, g.gh);
    for (const suffix of [
      "",
      "/",
      "/files?diff=split#L7",
      "/checks/job/123",
      "/commits/abc",
    ])
      assert.deepEqual(
        parseTarget(target.url + suffix, f.service.config),
        target,
      );
    for (const url of [
      "https://github.com/%65xample/repo/pull/42",
      "https://github.com/example/.git/pull/42",
      "https://github.com/example/repo%3Fq/pull/42",
      "https://github.com/example/repo/pull/0",
      "https://github.com:123/example/repo/pull/42",
    ])
      assert.throws(() => parseTarget(url, f.service.config));
    const s = await providers.snapshot(target);
    assert.equal(s.base, base);
    assert.equal(s.head, head);
    assert.notEqual(s.base, tip);
    assert.equal(s.files[0].oldPath, "src/old.ts");
    assert.equal(s.files[0].truncated, false);
    assert.equal(s.target.url, target.url);
    assert.equal(
      (await providers.source(s, "src/new.ts", "new")).content,
      text,
    );
    assert.equal((await providers.tree(s, "src", "old"))[0].path, "src/new.ts");
    const status = await providers.github.diagnose();
    assert.equal(status.authenticated, true);
    const namedPulls = ghFixture("example/pulls");
    await namedPulls.gh.snapshot(githubTarget("example/pulls", 42));
    assert.ok(
      namedPulls.calls.some(
        (c) =>
          c.endpoint ===
          "repos/example/pulls/issues/42/comments?per_page=100&page=1",
      ),
    );
    for (const c of g.calls.filter((c) => c.endpoint)) {
      assert.ok(c.args.includes("--hostname"));
      assert.ok(c.args.includes("github.com"));
    }
  } finally {
    f.cleanup();
  }
});

test("GitHub snapshot rejects moved refs and incomplete or oversized comparisons", async () => {
  for (const field of ["head", "base", "count"] as const) {
    const g = ghFixture();
    g.onMeta((count) => {
      if (count === 2) {
        if (field === "head") g.meta.head.sha = "f".repeat(40);
        else if (field === "base") g.meta.base.sha = "f".repeat(40);
        else g.meta.changed_files++;
      }
    });
    await assert.rejects(g.gh.snapshot(target), code("revision_changed"));
  }
  const g = ghFixture();
  g.meta.changed_files = 301;
  await assert.rejects(g.gh.snapshot(target), code("github_diff_limit"));
  assert.equal(g.calls.length, 1);
  g.meta.changed_files = 2;
  await assert.rejects(g.gh.snapshot(target), code("github_diff_incomplete"));
  g.meta.changed_files = 1;
  g.comparison.files[0].patch = "@@ -1,1 +1,1 @@\n-old";
  const s = await g.gh.snapshot(target);
  assert.equal(s.files[0].truncated, true);
  await assert.rejects(
    g.gh.publish(s, "must not post", {
      path: "src/new.ts",
      side: "new",
      start: 1,
      end: 1,
    }),
    code("unmappable_anchor"),
  );
  g.comparison.base_commit.sha = "f".repeat(40);
  await assert.rejects(g.gh.snapshot(target), code("missing_revision"));
});

test("GitHub discussions paginate, retain replies and omit pending private reviews", async () => {
  const g = ghFixture();
  g.ordinary.push(
    ...Array.from({ length: 101 }, (_, i) => ({
      id: i + 1,
      body: `ordinary-${i}`,
      user: { login: "reader" },
    })),
  );
  g.reviews.push(
    { id: 11, state: "PENDING", body: "PRIVATE REVIEW" },
    { id: 12, state: "APPROVED", body: "Review summary" },
  );
  g.inline.push(
    {
      id: 20,
      body: "Inline",
      pull_request_review_id: 10,
      side: "LEFT",
      path: "src/old.ts",
      line: 2,
    },
    {
      id: 21,
      in_reply_to_id: 20,
      body: "Reply",
      pull_request_review_id: 12,
      side: "LEFT",
      path: "src/old.ts",
      line: null,
      original_line: 2,
    },
    { id: 22, body: "PRIVATE INLINE", pull_request_review_id: 11 },
    { id: 23, body: "UNVERIFIED REVIEW", pull_request_review_id: 99 },
  );
  const s = await g.gh.snapshot(target);
  assert.equal(s.comments.length, 104);
  assert.ok(!JSON.stringify(s.comments).includes("PRIVATE"));
  assert.ok(!JSON.stringify(s.comments).includes("UNVERIFIED"));
  const reply = s.comments.find((c) => c.id === "inline:21")!;
  assert.equal(reply.threadId, "inline:20");
  assert.equal(reply.side, "old");
  assert.equal(reply.outdated, true);
  assert.equal(reply.line, 2);
  assert.ok(
    g.calls.some((c) => c.endpoint?.endsWith("/comments?per_page=100&page=2")),
  );
});

test("GitHub pinned tree/blob reads reject indirection, binary, LFS and corrupt source", async () => {
  const g = ghFixture(),
    s = await g.gh.snapshot(target);
  const old = await g.gh.source(s, "src/old.ts", "old");
  assert.equal(old.commit, base);
  assert.equal(old.versionId, s.id);
  const entries = await g.gh.tree(s, "src", "new");
  assert.equal(entries.find((e) => e.name === "secret")?.type, "symlink");
  assert.equal(entries.find((e) => e.name === "module")?.type, "submodule");
  for (const p of [
    "src/secret",
    "src/module",
    "src/secret/file",
    "../secret",
    ".git/config",
    "--ref",
    "src/missing",
  ])
    await assert.rejects(g.gh.source(s, p, "new"));
  const endpoint = `repos/${target.repo}/git/blobs/${blobSha}`;
  const blob = g.responses.get(endpoint);
  for (const replacement of [
    { ...blob, content: Buffer.alloc(blob.size, 0).toString("base64") },
    { ...blob, content: Buffer.alloc(blob.size, 255).toString("base64") },
    { ...blob, size: blob.size + 1 },
    { ...blob, sha: "f".repeat(40) },
    { ...blob, encoding: "none" },
  ]) {
    g.responses.set(endpoint, replacement);
    await assert.rejects(
      g.gh.source(s, "src/new.ts", "new"),
      code("source_unavailable"),
    );
  }
  const lfs =
    "version https://git-lfs.github.com/spec/v1\noid sha256:example\n";
  const h = ghFixture();
  h.responses.get(`repos/${target.repo}/git/trees/${dir}`).tree[0].size =
    Buffer.byteLength(lfs);
  h.responses.set(endpoint, {
    ...blob,
    size: Buffer.byteLength(lfs),
    content: Buffer.from(lfs).toString("base64"),
  });
  await assert.rejects(
    h.gh.source(s, "src/new.ts", "new"),
    code("source_unavailable"),
  );
  const large = ghFixture();
  large.responses.get(`repos/${target.repo}/git/trees/${dir}`).tree[0].size =
    1024 * 1024 + 1;
  await assert.rejects(
    large.gh.source(s, "src/new.ts", "new"),
    code("source_unavailable"),
  );
  assert.ok(!large.calls.some((c) => c.endpoint?.includes("/blobs/")));
  const truncated = ghFixture();
  truncated.responses.get(`repos/${target.repo}/git/trees/${head}`).truncated =
    true;
  await assert.rejects(
    truncated.gh.tree(s, ".", "new"),
    code("source_unavailable"),
  );
  truncated.responses.get(`repos/${target.repo}/git/trees/${head}`).truncated =
    false;
  assert.equal((await truncated.gh.tree(s, ".", "new")).length, 1);
  await assert.rejects(
    g.gh.snapshot({ ...target, host: "evil.example" }),
    code("source_host_not_allowed"),
  );
});

test("GitHub publishes exact ordinary and renamed/deletion/multiline review payloads via stdin", async () => {
  const g = ghFixture(),
    s = await g.gh.snapshot(target);
  const body =
    "Literal `code` and $(never execute)\n多行评论\n<!-- unfold-publication:test -->";
  assert.deepEqual(await g.gh.publish(s, body), { id: "issue:987" });
  const general = g.calls.at(-1)!;
  assert.equal(general.endpoint, `repos/${target.repo}/issues/42/comments`);
  assert.deepEqual(general.body, { body });
  assert.ok(!general.args.some((a) => a.includes(body)));
  assert.deepEqual(general.args.slice(-2), ["--input", "-"]);
  await g.gh.publish(s, body, {
    path: "src/old.ts",
    side: "old",
    start: 2,
    end: 2,
  });
  assert.deepEqual(g.calls.at(-1)!.body, {
    body,
    commit_id: head,
    path: "src/new.ts",
    side: "LEFT",
    line: 2,
  });
  s.files[0].path = "src/old.ts";
  s.files[0].patch = "@@ -1,3 +0,0 @@\n-one\n-two\n-three";
  await g.gh.publish(s, body, {
    path: "src/old.ts",
    side: "old",
    start: 1,
    end: 3,
  });
  assert.deepEqual(g.calls.at(-1)!.body, {
    body,
    commit_id: head,
    path: "src/old.ts",
    side: "LEFT",
    line: 3,
    start_line: 1,
    start_side: "LEFT",
  });
  for (const anchor of [
    { path: "src/old.ts", side: "old", start: 1, end: 4 },
    { path: "src/old.ts", side: "new", start: 1, end: 1 },
    { path: "src/old.ts", side: "old", start: 0, end: 0 },
    { path: "src/new.ts", side: "old", start: 1, end: 1 },
  ] as const)
    await assert.rejects(g.gh.publish(s, body, anchor));
});

test("GitHub access errors are actionable and publication uncertainty reconciles without duplicates", async () => {
  for (const [message, expected] of [
    ["gh auth login", "github_auth_required"],
    ["HTTP 401", "github_auth_required"],
    ["HTTP 403", "github_access_denied"],
    ["HTTP 429", "github_access_denied"],
    ["HTTP 404", "github_not_found"],
    ["HTTP 422", "github_validation_failed"],
    ["timeout", "github_request_failed"],
  ]) {
    const gh = new GitHub(async () => {
      throw new Error(message);
    });
    await assert.rejects(gh.snapshot(target), code(expected));
    assert.equal((await gh.diagnose()).authenticated, false);
  }
  const f = fixture(),
    g = ghFixture();
  const original = f.service.rpc.bind(f.service);
  f.service.rpc = async <T>(method: string, p: any): Promise<T> => {
    if (method === "snapshot") return (await g.gh.snapshot(p.target)) as T;
    if (method === "source")
      return (await g.gh.source(p.snapshot, p.path, p.side)) as T;
    if (method === "publish")
      return (await g.gh.publish(p.snapshot, p.body, p.anchor)) as T;
    return original(method, p);
  };
  try {
    const r = await f.service.import(target.url + "/files#diff");
    assert.equal((await f.service.import(target.url)).id, r.id);
    const d = f.service.createDraft(r.id, "A complete standalone question");
    const preview = f.service.preview(d.id);
    assert.ok(preview.warning?.includes("PR comment"));
    assert.ok(!preview.body.includes(f.service.config.shareBaseUrl));
    assert.ok(!preview.body.includes("Explanation:"));
    await assert.rejects(
      f.service.publish(d.id, "wrong"),
      code("confirmation_required"),
    );
    g.failAfterWrite();
    assert.equal(
      (await f.service.publish(d.id, preview.digest)).state,
      "unknown",
    );
    await assert.rejects(
      f.service.publish(d.id, preview.digest),
      code("publication_unknown"),
    );
    const reconciled = await f.service.reconcile(d.id);
    assert.equal(reconciled.state, "published");
    assert.equal(reconciled.remoteId, "issue:987");
    assert.equal(
      (await f.service.publish(d.id, preview.digest)).remoteId,
      "issue:987",
    );
    assert.equal(g.calls.filter((c) => c.body).length, 1);
    const stale = f.service.createDraft(r.id, "A stale question");
    const digest = f.service.preview(stale.id).digest;
    g.meta.head.sha = "f".repeat(40);
    g.responses.set(
      `repos/${target.repo}/compare/${tip}...${g.meta.head.sha}?per_page=1`,
      g.comparison,
    );
    await assert.rejects(
      f.service.publish(stale.id, digest),
      code("stale_draft"),
    );
    assert.equal(g.calls.filter((c) => c.body).length, 1);
  } finally {
    f.cleanup();
  }
});

test("subprocess JSON input preserves literal shell syntax and Unicode without execution", async () => {
  const input = JSON.stringify({ body: "$(exit 9) `exit 8`\n中文\n" });
  const output = await command(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input },
  );
  assert.equal(output, input);
});

test("GitHub transient HTTP reads retry within a bound and uncertain writes are sent once", async () => {
  let reads = 0;
  const gh = new GitHub(async () => {
    reads++;
    if (reads < 3) throw new Error("gh: Service Unavailable (HTTP 503)");
    return JSON.stringify({ login: "reader" });
  });
  assert.equal((await gh.api("user")).login, "reader");
  assert.equal(reads, 3);
  let writes = 0;
  const down = new GitHub(async () => {
    writes++;
    throw new Error("HTTP 503");
  });
  await assert.rejects(
    down.api("repos/example/repo/issues/42/comments", { body: "No retry" }),
    code("github_request_failed"),
  );
  assert.equal(writes, 1);
  writes = 0;
  await assert.rejects(down.api("user"), code("github_request_failed"));
  assert.equal(writes, 3);
});
