import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  prepareReview,
  PrepareError,
  cliInvoker,
} from "../plugins/unfold/skills/unfold-review/scripts/prepare.mjs";

const execute = promisify(execFile);
const version = { id: "version", head: "a".repeat(40), base: "b".repeat(40) };
const options = {
  url: "https://code.example.test/team/repo/merge_requests/42",
  head: version.head,
};
const explanation = {
  id: "explanation",
  reviewId: "review",
  versionId: version.id,
  title: "取消已排队的任务",
  summary: "在获取 worker 前检查取消状态。",
  html: "<h1>说明</h1>",
  guide: { groups: [{ title: "取消路径", points: [{ title: "前移检查" }] }] },
  backend: "codex",
  model: "test-model",
  effort: "high",
};
const run = {
  id: "run",
  reviewId: "review",
  kind: "analysis",
  versionId: version.id,
  state: "running",
  backend: "codex",
  model: "test-model",
  effort: "high",
};
function scenario(
  settings: {
    initial?: any;
    refreshVersion?: any;
    finalVersion?: any;
    remoteVersion?: any;
    active?: any[];
    resumed?: any;
    terminal?: any;
    shareBase?: string;
    viewerMode?: string;
    publicHead?: string;
    visitorError?: boolean;
    watchError?: boolean;
  } = {},
) {
  const calls: string[][] = [],
    visits: { url: string; options?: RequestInit }[] = [],
    events: any[] = [];
  const review = {
    id: "review",
    versionId: version.id,
    target: { url: options.url },
  };
  let refreshes = 0;
  const invoke = async (args: string[]) => {
    calls.push([...args]);
    switch (args[0]) {
      case "import":
        return structuredClone(review);
      case "refresh": {
        const v =
          ++refreshes > 1
            ? settings.finalVersion || version
            : settings.refreshVersion || version;
        return structuredClone({
          review: { ...review, versionId: v.id },
          version: v,
          explanation: settings.initial,
        });
      }
      case "versions":
        return [settings.remoteVersion || version];
      case "share":
        return {
          url: `${settings.shareBase || "https://review.example.test"}/r/review${args.includes("--explanation") ? "/v/explanation" : ""}`,
        };
      case "runs":
        return structuredClone(settings.active || []);
      case "run":
        return structuredClone(settings.resumed || run);
      case "analyze":
        return structuredClone(run);
      case "watch":
        if (settings.watchError)
          throw new PrepareError("event_stream_failed", "Connection lost");
        return structuredClone(
          settings.terminal || {
            ...run,
            state: "succeeded",
            explanationId: explanation.id,
          },
        );
      case "show":
        return { explanation: structuredClone(explanation) };
      default:
        throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
    }
  };
  const visitorFetch = (async (url: any, requestOptions?: RequestInit) => {
    visits.push({ url: String(url), options: requestOptions });
    assert.equal(requestOptions?.credentials, "omit");
    assert.equal(requestOptions?.headers, undefined);
    assert.equal(requestOptions?.redirect, "error");
    if (settings.visitorError) throw new Error("Network unavailable");
    return Response.json(
      String(url).endsWith("/healthz")
        ? { status: "ok", mode: settings.viewerMode || "viewer" }
        : {
            ok: true,
            data: {
              explanation,
              version: {
                ...version,
                head: settings.publicHead || version.head,
              },
            },
          },
    );
  }) as typeof fetch;
  return {
    calls,
    visits,
    events,
    prepare: (overrides = {}) =>
      prepareReview({ ...options, ...overrides }, invoke, visitorFetch, (e) =>
        events.push(e),
      ),
  };
}
const has = (s: ReturnType<typeof scenario>, command: string) =>
  s.calls.some((c) => c[0] === command);
const rejects = (
  s: ReturnType<typeof scenario>,
  code: string,
  exit: number,
  overrides = {},
) =>
  assert.rejects(
    s.prepare(overrides),
    (error: any) => error.code === code && error.exit === exit,
  );

test("post-submission helper reuses only the current complete explanation and verifies credential-free pinned access", async () => {
  const s = scenario({ initial: explanation });
  const result = await s.prepare();
  assert.equal(result.status, "ready");
  assert.equal(
    result.url,
    "https://review.example.test/r/review/v/explanation",
  );
  assert.equal(result.head, version.head);
  assert.equal(result.reused, true);
  assert.ok(
    result.message.includes(result.url) &&
      result.message.includes(version.head),
  );
  assert.ok(!has(s, "analyze") && !has(s, "watch"));
  assert.equal(s.calls.filter((c) => c[0] === "refresh").length, 2);
  assert.equal(s.visits.length, 2);
});

test("stale default bundles resolve the remote version and forward explicit backend/model/effort to a new analysis", async () => {
  const old = { ...version, id: "old", head: "c".repeat(40) };
  // Simulate bundle.version belonging to an older published explanation while review.versionId is current.
  const calls: string[][] = [];
  let refreshes = 0;
  const invoke = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "import")
      return { id: "review", target: { url: options.url } };
    if (args[0] === "refresh")
      return {
        review: { versionId: version.id },
        version: ++refreshes === 1 ? old : version,
        explanation: { ...explanation, versionId: old.id },
      };
    if (args[0] === "versions") return [version];
    if (args[0] === "runs") return [];
    if (args[0] === "analyze") return run;
    if (args[0] === "watch")
      return { ...run, state: "succeeded", explanationId: explanation.id };
    if (args[0] === "show") return { explanation };
    if (args[0] === "share")
      return {
        url:
          "https://review.example.test/r/review" +
          (args.length > 2 ? "/v/explanation" : ""),
      };
    throw Error("Unexpected command");
  };
  const visitor = (async (url: any) =>
    Response.json(
      String(url).endsWith("/healthz")
        ? { status: "ok", mode: "viewer" }
        : { ok: true, data: { explanation, version } },
    )) as typeof fetch;
  const result = await prepareReview(
    { ...options, backend: "codex", model: "test-model", effort: "high" },
    invoke,
    visitor,
  );
  assert.equal(result.reused, false);
  assert.equal(result.runId, run.id);
  assert.ok(calls.some((c) => c[0] === "versions"));
  assert.deepEqual(
    calls.find((c) => c[0] === "analyze"),
    [
      "analyze",
      "review",
      "--backend",
      "codex",
      "--model",
      "test-model",
      "--effort",
      "high",
    ],
  );
});

test("duplicate preparation attaches to an active matching analysis and explicit regeneration bypasses reuse", async () => {
  for (const settings of [
    { active: [run] },
    { initial: explanation, active: [run] },
  ]) {
    const s = scenario(settings);
    const result = await s.prepare({ regenerate: true });
    assert.equal(result.runId, run.id);
    assert.ok(!has(s, "analyze"));
    assert.equal(s.calls.filter((c) => c[0] === "watch").length, 1);
    assert.equal(s.events[0].runId, run.id);
  }
});

test("pending approvals and failed terminal runs preserve recovery IDs without returning previous explanations", async () => {
  for (const state of ["awaiting_approval", "failed", "interrupted"]) {
    const s = scenario({
      initial: { ...explanation, versionId: "old" },
      active: [{ ...run, state: "awaiting_approval" }],
      resumed: { ...run, state },
    });
    await assert.rejects(s.prepare({ resume: run.id }), (error: any) => {
      assert.equal(
        error.code,
        state === "awaiting_approval"
          ? "confirmation_required"
          : "analysis_failed",
      );
      assert.equal(error.exit, state === "awaiting_approval" ? 3 : 1);
      assert.equal(error.details.runId, run.id);
      return true;
    });
    assert.ok(!has(s, "show") && !has(s, "analyze") && !has(s, "watch"));
    assert.equal(s.calls.filter((c) => c[0] === "share").length, 1);
  }
});

test("source and base races prevent ready results both before and after generation", async () => {
  const before = scenario({
    refreshVersion: { ...version, head: "d".repeat(40) },
  });
  await rejects(before, "revision_conflict", 4);
  assert.ok(!has(before, "analyze"));
  for (const finalVersion of [
    { ...version, head: "d".repeat(40) },
    { ...version, base: "e".repeat(40) },
  ]) {
    const s = scenario({ finalVersion });
    await rejects(s, "revision_conflict", 4);
    assert.ok(has(s, "analyze"));
    assert.equal(s.calls.filter((c) => c[0] === "share").length, 1);
  }
});

test("explicit resume cannot observe a foreign review, version, question or model profile", async () => {
  for (const resumed of [
    { ...run, reviewId: "other" },
    { ...run, versionId: "old" },
    { ...run, kind: "question" },
    { ...run, model: "other-model" },
  ]) {
    const s = scenario({ resumed });
    await rejects(s, "run_conflict", 4, {
      resume: run.id,
      model: "test-model",
    });
    assert.ok(!has(s, "watch") && !has(s, "analyze"));
  }
});

test("private and owner listeners are rejected and public evidence must match the generated revision", async () => {
  for (const shareBase of [
    "https://owner.example.ts.net",
    "http://100.64.0.1",
    "http://[fd7a:115c:a1e0::1]",
    "http://localhost",
    "http://127.0.0.1",
    "https://key:secret@review.example.test",
  ]) {
    const s = scenario({ shareBase });
    await rejects(s, "invalid_share_url", 2);
    assert.equal(s.visits.length, 0);
    assert.ok(!has(s, "analyze"));
  }
  await rejects(scenario({ viewerMode: "owner" }), "invalid_share_listener", 2);
  await rejects(scenario({ publicHead: "f".repeat(40) }), "share_not_ready", 1);
  await rejects(scenario({ visitorError: true }), "share_unreachable", 1);
});

test("transport loss keeps the accepted run ID and never resubmits analysis", async () => {
  const s = scenario({ watchError: true });
  await assert.rejects(
    s.prepare(),
    (error: any) =>
      error.code === "event_stream_failed" && error.details.runId === run.id,
  );
  assert.equal(s.calls.filter((c) => c[0] === "analyze").length, 1);
  assert.equal(s.events[0].runId, run.id);
});

test("standalone Node helper invokes CLI arguments literally and retains structured nonzero run outcomes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-plugin-"));
  try {
    const executable = path.join(root, "cli with spaces.mjs");
    await writeFile(
      executable,
      `const args=process.argv.slice(2);console.log(JSON.stringify({ok:true,data:{args,state:args.includes('watch')?'awaiting_approval':undefined}}));if(args.includes('watch'))process.exitCode=3;`,
    );
    const tokenFile = path.join(root, "private token");
    const invoke = cliInvoker({
      ...options,
      cli: executable,
      server: "https://owner.example.test",
      tokenFile,
    });
    const literal = "test-model $(touch should-not-exist) `echo test`";
    const result = await invoke(["analyze", "review", "--model", literal]);
    assert.deepEqual(result.args, [
      "--json",
      "--server",
      "https://owner.example.test",
      "--token-file",
      tokenFile,
      "analyze",
      "review",
      "--model",
      literal,
    ]);
    assert.equal((await invoke(["watch", "run"])).state, "awaiting_approval");
    const script = path.join(root, "prepare.mts");
    await writeFile(path.join(root, "package.json"), '{"type":"commonjs"}');
    await copyFile(
      path.resolve("plugins/unfold/skills/unfold-review/scripts/prepare.mts"),
      script,
    );
    assert.match(
      (await execute(process.execPath, [script, "--help"], { cwd: root }))
        .stdout,
      /Usage:/,
    );
    await assert.rejects(
      execute(process.execPath, [script, options.url, "--head", "short"], {
        cwd: root,
      }),
      (error: any) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stderr).error.code, "invalid_input");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
