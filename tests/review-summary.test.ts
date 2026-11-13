import test from "node:test";
import assert from "node:assert/strict";
import { reviewSummary } from "../src/review-summary.js";
import { createServer } from "../src/server.js";
import { fixture, seed } from "./fixtures.js";
import { secret } from "../src/config.js";

test("handoff summarizes direct changes by path with saved owners, bounded text and a pinned version", async () => {
  const f = fixture(),
    { review, explanation } = await seed(f.service);
  try {
    const version = f.service.version(review.id);
    version.files.push({
      ...version.files[0],
      path: "shared/contract.ts",
      oldPath: "old/contract.ts",
    });
    explanation.guide!.groups[1].points[0].files = ["shared/contract.ts"];
    explanation.guide!.groups[1].points[0].title = "统一共享回调约定";
    for (let i = 1; i <= 4; i++)
      explanation.guide!.groups[0].points.push({
        ...explanation.guide!.groups[0].points[0],
        id: `g1-extra-${i}`,
        title: `补充第 ${i} 个资源释放边界的行为说明与异常处理`,
      });
    explanation.ownership = {
      versionId: version.id,
      provider: "codebase",
      capturedAt: "2026-01-01T00:00:00Z",
      status: "partial",
      rules: [],
      warnings: [],
      files: [
        {
          path: "src/queue.ts",
          side: "new",
          owners: ["runtime"],
          ruleIds: [],
          status: "resolved",
        },
        {
          path: "shared/contract.ts",
          side: "new",
          owners: ["contracts"],
          ruleIds: [],
          status: "resolved",
        },
        {
          path: "old/contract.ts",
          side: "old",
          owners: [],
          ruleIds: [],
          status: "unknown",
        },
      ],
    };
    explanation.summary =
      "**让取消任务提前退出**，避免占用 worker。 https://localhost/private https://owner.test.ts.net/private " +
      "额外背景。".repeat(100);
    const result = reviewSummary(
      review,
      version,
      explanation,
      "https://review.example.test/r/r/v/e",
    );
    assert.match(result.text, /@runtime · src\/：把取消检查前移/);
    assert.match(result.text, /@contracts · shared\/：统一共享回调约定/);
    assert.match(result.text, /owner 待确认 · old\/：统一共享回调约定/);
    assert.ok(result.text.startsWith(result.overview + "\n"));
    assert.ok(
      !result.text.includes(`${review.target.repo} !${review.target.number}：`),
    );
    assert.ok(
      result.text.includes(`完整讲解（${version.head.slice(0, 8)}）：`),
    );
    const runtime = result.sections.find((s) => s.path === "src")!;
    assert.ok(runtime.summary.length > 68);
    assert.ok(runtime.summary.includes("第 4 个资源释放边界"));
    assert.equal(runtime.pointIds.length, 5);
    assert.equal(runtime.otherPoints, 0);
    assert.doesNotMatch(result.text, /另 \d+ 项见讲解/);
    assert.ok(
      !result.sections
        .find((s) => s.path === "shared")!
        .summary.includes("取消"),
    );
    assert.ok(!result.text.includes("localhost"));
    assert.ok(!result.text.includes("ts.net"));
    assert.ok(Array.from(result.overview).length <= 110);
    const completeSentence =
      "先处理取消状态，" +
      "避免已取消任务占用执行资源，".repeat(4) +
      "再执行工作。";
    assert.equal(
      reviewSummary(
        review,
        version,
        {
          ...explanation,
          summary: completeSentence + "另外还需调查更广泛的行为".repeat(20),
        },
        result.url,
      ).overview,
      completeSentence,
    );
    assert.equal(result.mentions, "plain-text");
    assert.ok(result.text.endsWith("https://review.example.test/r/r/v/e"));
    assert.equal(result.explanationId, explanation.id);
    assert.equal(result.stale, false);
    assert.match(
      reviewSummary(
        review,
        version,
        { ...explanation, summary: "改用 std::vector<double> 保存小数。" },
        result.url,
      ).text,
      /std::vector<double>/,
    );
    review.versionId = "newer-version";
    assert.match(
      reviewSummary(review, version, explanation, result.url).text,
      /讲解对应旧提交/,
    );
    assert.throws(() =>
      reviewSummary(
        review,
        { ...version, id: "wrong" },
        explanation,
        result.url,
      ),
    );
    // Even large reviews include every path and all its direct change titles.
    for (let i = 0; i < 10; i++) {
      version.files.push({
        ...version.files[0],
        path: `extra${i}/file.ts`,
        oldPath: `extra${i}/file.ts`,
      });
      explanation.guide!.groups[0].points[0].files.push(`extra${i}/file.ts`);
    }
    const many = reviewSummary(review, version, explanation, result.url);
    assert.equal(many.omittedPaths, 0);
    assert.equal(many.sections.length, 13);
    assert.match(many.text, /extra9\/：/);
    assert.doesNotMatch(many.text, /另 \d+ (项|个路径)见讲解/);
    delete explanation.guide;
    assert.match(
      reviewSummary(review, version, explanation, result.url).text,
      /路径摘要尚未生成/,
    );
  } finally {
    f.cleanup();
  }
});

test("owner/visitor summary reads agree, preserve historical identity, and never query private state or providers", async () => {
  const f = fixture(),
    { review, explanation } = await seed(f.service);
  f.service.rpc = async () => {
    throw Error("No provider read or generation is allowed");
  };
  f.service.store.put("run", {
    id: "private-question",
    reviewId: review.id,
    question: "PRIVATE-QUESTION-SENTINEL",
  });
  const owner = await createServer(f.service, true),
    viewer = await createServer(f.service, false);
  const endpoint = `/api/v1/reviews/${review.id}/review-summary?explanationId=${explanation.id}`;
  try {
    const a = await owner.inject({
      url: endpoint,
      headers: { authorization: `Bearer ${secret(f.root, "owner-token")}` },
    });
    const b = await viewer.inject(endpoint);
    assert.equal(a.statusCode, 200);
    assert.equal(a.body, b.body);
    const data = b.json().data;
    assert.ok(data.url.endsWith(`/r/${review.id}/v/${explanation.id}`));
    assert.match(data.text, /owner 待确认/);
    assert.ok(!b.body.includes("private-thread-id"));
    assert.ok(!b.body.includes("PRIVATE-QUESTION-SENTINEL"));
    const newer = {
      ...explanation,
      id: "newer-explanation",
      summary: "新讲解",
    };
    f.service.store.put("explanation", newer);
    f.service.store.put("review", { ...review, explanationId: newer.id });
    assert.equal((await viewer.inject(endpoint)).json().data.text, data.text);
    assert.equal(
      (await viewer.inject(endpoint.split("?")[0])).json().data.explanationId,
      newer.id,
    );
    for (const base of [
      "",
      "http://127.0.0.1:18371",
      "https://owner.test.ts.net",
    ]) {
      f.service.config.shareBaseUrl = base;
      assert.notEqual(
        (
          await owner.inject({
            url: endpoint,
            headers: {
              authorization: `Bearer ${secret(f.root, "owner-token")}`,
            },
          })
        ).statusCode,
        200,
      );
    }
    f.service.store.put("review", { ...review, explanationId: undefined });
    assert.equal((await viewer.inject(endpoint)).statusCode, 404);
  } finally {
    await owner.close();
    await viewer.close();
    f.cleanup();
  }
});
