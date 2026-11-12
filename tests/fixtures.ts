import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Service } from "../src/service.js";
import { hash } from "../src/util.js";
import { connectorRevision } from "../src/connector-runtime.js";
import type { Config } from "../src/config.js";
import type {
  ConfigApplication,
  Explanation,
  Snapshot,
  Source,
  Target,
} from "../src/types.js";
export const target: Target = {
  provider: "codebase",
  host: "code.example.test",
  repo: "sample/queue",
  number: 42,
  url: "https://code.example.test/sample/queue/merge_requests/42",
};
export const snapshot: Snapshot = {
  id: "version-one",
  target,
  title: "Make cancellation explicit",
  description: "Check cancellation before acquiring a worker.",
  head: "a".repeat(40),
  base: "b".repeat(40),
  remoteVersion: "1",
  repoId: "repository-test",
  mrId: "mr-test",
  fetchedAt: "2026-01-01T00:00:00Z",
  files: [
    {
      path: "src/queue.ts",
      oldPath: "src/queue.ts",
      patch:
        "diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1,3 +1,4 @@\n export function queue(item) {\n+  if (item.cancelled) return;\n   acquire(item);\n }",
      binary: false,
      truncated: false,
      added: 1,
      deleted: 0,
    },
  ],
  comments: [],
};
export const sourceText =
  "export function queue(item) {\n  if (item.cancelled) return;\n  acquire(item);\n}\n";
export function testConfig(root: string): Config {
  return {
    dataDir: path.join(root, "data"),
    socketPath: path.join(root, "connector.sock"),
    ownerPort: 19371,
    sharePort: 19370,
    shareBind: "127.0.0.1",
    shareBaseUrl: "https://review.example.test",
    ownerBaseUrl: "http://127.0.0.1:19371",
    codebaseHosts: ["code.example.test"],
    defaultBackend: "traex",
    agents: {
      traex: { executable: "traex", authFile: "/not-mounted" },
      codex: { executable: "codex", authFile: "/not-mounted" },
    },
  };
}
export class FakeService extends Service {
  current = structuredClone(snapshot);
  writes = 0;
  writeDelay = 0;
  uncertain = false;
  application?: ConfigApplication;
  reloads = 0;
  modelQueries = 0;
  override async rpc<T>(method: string, p: any): Promise<T> {
    let data: any;
    if (method === "reload_config" || method === "config_status") {
      if (method === "reload_config") this.reloads++;
      data = this.application || {
        state: "applied",
        desiredRevision: connectorRevision(this.config),
        appliedRevision: connectorRevision(this.config),
        activeOperations: 0,
      };
    } else if (method === "snapshot") {
      await new Promise((r) => setTimeout(r, 5));
      data = structuredClone(this.current);
    } else if (method === "source") {
      const s = p.snapshot as Snapshot;
      data = {
        id: hash(`${s.id}:${p.side}:${p.path}`).slice(0, 32),
        versionId: s.id,
        path: p.path,
        side: p.side,
        commit: p.side === "old" ? s.base : s.head,
        content: sourceText,
      } as Source;
    } else if (method === "models") {
      this.modelQueries++;
      const models = [
        {
          id: "test-model",
          model: "test-model",
          displayName: "Test Model",
          isDefault: true,
          defaultEffort: "medium",
          efforts: [
            { effort: "medium", description: "Default" },
            { effort: "high", description: "More reasoning" },
          ],
        },
      ];
      if (!p.profile) data = { backend: p.backend, models };
      else {
        const { resolveModelProfile } = await import("../src/agent.js");
        data = resolveModelProfile(models, p.profile);
      }
    } else if (method === "publish") {
      this.writes++;
      if (this.writeDelay)
        await new Promise((r) => setTimeout(r, this.writeDelay));
      const c = {
        id: `comment-${this.writes}`,
        body: p.body,
        author: "test-owner",
      };
      this.current.comments.push(c);
      if (this.uncertain)
        throw new Error("Connection lost after platform accepted the comment");
      data = { id: c.id };
    } else if (method === "health") data = { ready: true, backends: [] };
    else throw new Error("Unexpected fake method: " + method);
    return data as T;
  }
}
export function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "unfold-test-"));
  process.env.UNFOLD_HOME = root;
  const service = new FakeService(testConfig(root));
  return {
    root,
    service,
    cleanup: () => {
      service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
export async function seed(service: FakeService) {
  const r = await service.import(target.url);
  const reference = await service.createReference(
    r.id,
    snapshot.id,
    "src/queue.ts",
    "new",
    2,
    2,
  );
  const explanation: Explanation = {
    id: "explanation-one",
    reviewId: r.id,
    versionId: snapshot.id,
    title: "A clearer lifecycle for queued work",
    summary: "Cancelled work exits before a worker is acquired.",
    html: `<h1>A clearer lifecycle for queued work</h1><p>Cancelled work exits before acquiring a worker. This behavior follows the guard in the source.</p><div style="margin:32px 0;padding:24px;background:#f7f9f5"><p style="font-family:monospace;color:#789476">// an illustrative trace, not a test result</p><button id="before" onclick="document.getElementById('trace').textContent='Queue → acquire worker → check cancellation'">Before</button> <button id="after" onclick="document.getElementById('trace').textContent='Queue → check cancellation → return'">After</button><p id="trace" style="font-size:18px">Queue → check cancellation → return</p></div><h2>What changed</h2><p>The cancellation guard is now evaluated before work is acquired. <a data-unfold-ref="${reference.id}">src/queue.ts:2 ↗</a></p><h2>Tradeoffs & unknowns</h2><p>This source inspection does not prove race freedom or runtime behavior. No project tests were executed.</p><h2>Test evidence</h2><p>Source only. This synthetic fixture is for interface validation.</p>`,
    references: [reference],
    guide: {
      groups: [
        {
          id: "g1",
          title: "取消语义",
          category: "行为变更",
          summary: "先确认任务仍然有效，再进入执行路径。",
          points: [
            {
              id: "g1-c1",
              title: "把取消检查前移",
              summary: "已取消任务在获取 worker 前直接返回。",
              before: "先获取 worker，再检查取消状态。",
              after: "先检查取消状态，再获取 worker。",
              rationale: "在资源分配前处理无效任务。",
              risks: ["源码说明不等同于并发或运行验证。"],
              files: ["src/queue.ts"],
              referenceIds: [reference.id],
            },
          ],
        },
        {
          id: "g2",
          title: "资源获取路径",
          category: "资源管理",
          summary: "只有有效任务才进入 acquire。",
          points: [
            {
              id: "g2-c1",
              title: "缩小资源获取范围",
              summary: "取消路径不再占用 worker。",
              before: "取消任务仍可能经过 acquire。",
              after: "acquire 只服务未取消任务。",
              rationale: "减少取消路径上的无效资源操作。",
              risks: ["尚未执行项目测试。"],
              files: ["src/queue.ts"],
              referenceIds: [reference.id],
            },
          ],
        },
      ],
    },
    backend: "traex",
    model: "test-model",
    cliVersion: "test-cli",
    threadId: "private-thread-id",
    createdAt: "2026-01-01T00:00:00Z",
  };
  service.store.put("explanation", explanation);
  r.explanationId = explanation.id;
  service.store.put("review", r);
  return { review: r, reference, explanation };
}
