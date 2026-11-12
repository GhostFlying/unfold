import test from "node:test";
import assert from "node:assert/strict";
import { UsageTracker, tokenCounts } from "../src/telemetry.js";
import { fixture, seed } from "./fixtures.js";
import { Store } from "../src/store.js";
import type { AgentEvent, Explanation, Run } from "../src/types.js";
import { writingStyle } from "../src/writing-style.js";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import http from "node:http";
const counts = (n: number) => ({
  inputTokens: n,
  cachedInputTokens: n / 2,
  outputTokens: 20,
  reasoningOutputTokens: 4,
  totalTokens: n + 20,
});

test("native usage snapshots replace repeated totals and subtract the restored session baseline", () => {
  const events: AgentEvent[] = [];
  const tracker = new UsageTracker(true, (e) => events.push(e));
  tracker.threadId = "thread";
  tracker.notification({
    threadId: "thread",
    turnId: "old",
    tokenUsage: { total: counts(1000) },
  });
  tracker.begin();
  tracker.turn("new");
  const notify = (n: number, turnId = "new", threadId = "thread") =>
    tracker.notification({
      threadId,
      turnId,
      tokenUsage: { total: counts(n) },
    });
  notify(1200);
  notify(1200);
  notify(1600, "old");
  notify(1600, "new", "another");
  notify(1400);
  assert.equal(events.length, 2);
  assert.deepEqual(events.at(-1)?.usage, {
    inputTokens: 400,
    cachedInputTokens: 200,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 400,
    source: "app-server",
    scope: "run",
  });
  notify(100);
  assert.equal(events.length, 2);
  const missing: AgentEvent[] = [];
  assert.equal(tokenCounts({ ...counts(100), inputTokens: 0 }), undefined);
  const unknown = new UsageTracker(true, (e) => missing.push(e));
  unknown.begin();
  unknown.turn("x");
  unknown.notification({ turnId: "x", tokenUsage: { total: counts(2000) } });
  assert.equal(missing.length, 0);
  const fresh = new UsageTracker(false, (e) => missing.push(e));
  fresh.begin();
  fresh.turn("x");
  fresh.notification({ turnId: "x", tokenUsage: { total: counts(2000) } });
  assert.equal((missing[0].usage as any).totalTokens, 2020);
});

test("progress and observed usage survive a service restart, including cancelled work", async () => {
  const f = fixture();
  try {
    const { review } = await seed(f.service);
    const run: Run = {
      id: "progress-run",
      reviewId: review.id,
      versionId: review.versionId,
      kind: "analysis",
      state: "running",
      backend: "codex",
      createdAt: new Date().toISOString(),
    };
    f.service.store.put("run", run);
    f.service.record(run.id, {
      type: "status",
      stage: "investigating",
      source: "agent",
      message: "Verified the source",
      filesRead: 3,
      savedParts: 2,
      savedChars: 4000,
    });
    f.service.record(run.id, { type: "usage", usage: counts(1000) });
    f.service.cancel(run.id);
    f.service.store.close();
    f.service.store = new Store(f.service.config.dataDir);
    const saved = f.service.store.get<Run>("run", run.id);
    assert.equal(saved.state, "interrupted");
    assert.equal(saved.progress?.message, "Verified the source");
    assert.equal(saved.progress?.savedParts, 2);
    assert.equal(saved.progress?.savedChars, 4000);
    assert.equal(saved.usage?.totalTokens, 1020);
    assert.equal(saved.usage?.cachedInputTokens, 500);
    assert.ok(saved.progress?.at && saved.usage?.updatedAt);
    assert.equal(f.service.store.events(run.id).length, 3);
  } finally {
    f.cleanup();
  }
});

test("streamed usage, progress and writing policy survive terminal writes and store reopening", async () => {
  const f = fixture();
  let fail = false;
  let artifact: Explanation | undefined;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const events = [
      {
        type: "identity",
        threadId: "synthetic-thread",
        model: "test-model",
        effort: "medium",
        cliVersion: "synthetic 1",
        writingStyle,
      },
      { type: "turn", turnId: "synthetic-turn" },
      { type: "usage", usage: counts(2000) },
      { type: "status", stage: "validating", message: "Validating the answer" },
      fail
        ? {
            type: "failure",
            code: "deliberate_failure",
            message: "Backend stopped",
          }
        : {
            type: "result",
            answer: "Synthetic answer",
            threadId: "synthetic-thread",
            model: "test-model",
            effort: "medium",
            cliVersion: "synthetic 1",
            references: [],
            artifact,
          },
    ];
    res.end(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });
  await new Promise<void>((resolve) =>
    server.listen(f.service.config.socketPath, resolve),
  );
  try {
    const { review, explanation } = await seed(f.service);
    artifact = explanation;
    const ids: string[] = [];
    for (const [kind, failure] of [
      ["question", false],
      ["question", true],
      ["analysis", false],
    ] as const) {
      fail = failure;
      const run = await f.service.startRun(review.id, kind, {
        question: "Synthetic private question",
      });
      ids.push(run.id);
      await f.service.tasks.get(run.id);
      const saved = f.service.store.get<Run>("run", run.id);
      assert.equal(saved.state, failure ? "failed" : "succeeded");
      assert.equal(saved.usage?.totalTokens, 2020);
      assert.equal(saved.progress?.message, "Validating the answer");
      assert.equal(saved.turnId, "synthetic-turn");
      assert.deepEqual(saved.writingStyle, writingStyle);
      if (kind === "analysis")
        assert.deepEqual(
          f.service.store.get<Explanation>("explanation", saved.explanationId!)
            .writingStyle,
          writingStyle,
        );
      assert.equal(f.service.store.events(run.id).at(-1)?.type, "finished");
    }
    f.service.store.close();
    f.service.store = new Store(f.service.config.dataDir);
    for (const id of ids)
      assert.deepEqual(
        f.service.store.get<Run>("run", id).writingStyle,
        writingStyle,
      );
    const analysis = f.service.store.get<Run>("run", ids.at(-1)!);
    assert.deepEqual(
      f.service.store.get<Explanation>("explanation", analysis.explanationId!)
        .writingStyle,
      writingStyle,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.cleanup();
  }
});

test("legacy explanation HTML migrates to a file while metadata, IDs and read APIs survive reopening", async () => {
  const f = fixture();
  try {
    const { explanation } = await seed(f.service);
    f.service.store.db
      .prepare("UPDATE items SET data=? WHERE kind='explanation' AND id=?")
      .run(JSON.stringify(explanation), explanation.id);
    f.service.store.close();
    f.service.store = new Store(f.service.config.dataDir);
    const stored = JSON.parse(
      (
        f.service.store.db
          .prepare("SELECT data FROM items WHERE kind='explanation' AND id=?")
          .get(explanation.id) as any
      ).data,
    );
    assert.equal(stored.html, undefined);
    assert.equal(stored.htmlFile, `explanation/${explanation.id}.html`);
    const file = path.join(
      f.service.config.dataDir,
      "artifacts",
      stored.htmlFile,
    );
    assert.equal(readFileSync(file, "utf8"), explanation.html);
    assert.deepEqual(
      f.service.store.get("explanation", explanation.id),
      explanation,
    );
    f.service.store.close();
    f.service.store = new Store(f.service.config.dataDir);
    assert.equal(
      f.service.store.get<any>("explanation", explanation.id).html,
      explanation.html,
    );
    unlinkSync(file);
    assert.throws(
      () => f.service.store.get("explanation", explanation.id),
      /unavailable/,
    );
    assert.ok(
      f.service.store.db
        .prepare("SELECT id FROM items WHERE id=?")
        .get(explanation.id),
    );
  } finally {
    f.cleanup();
  }
});
