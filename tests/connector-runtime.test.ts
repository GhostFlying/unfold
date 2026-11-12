import test from "node:test";
import assert from "node:assert/strict";
import { ConnectorRuntime } from "../src/connector-runtime.js";
import { testConfig } from "./fixtures.js";
import type { Config } from "../src/config.js";
const initial = () => testConfig("/tmp/unfold-runtime-test");
const changed = (model: string): Config => {
  const c = initial();
  c.agents.traex.model = model;
  return c;
};

test("unchanged connector settings do not reload even with reordered object fields", async () => {
  const cfg = initial();
  let builds = 0;
  const runtime = new ConnectorRuntime(cfg, cfg, async (next) => {
    builds++;
    return next;
  });
  const same = {
    ...cfg,
    agents: { codex: cfg.agents.codex, traex: cfg.agents.traex },
    ownerBaseUrl: "https://owner.example.test",
  };
  assert.equal((await runtime.reload(same)).state, "applied");
  assert.equal(builds, 0);
});

test("an operation and its approval wait keep their original runtime; latest saved settings apply when released", async () => {
  const cfg = initial();
  const applied: Config[] = [];
  const runtime = new ConnectorRuntime(cfg, cfg, async (next) => {
    applied.push(next);
    return next;
  });
  const operation = await runtime.acquire(cfg);
  assert.equal((await runtime.reload(changed("first"))).state, "pending");
  await runtime.reload(changed("latest"));
  assert.equal(runtime.status().activeOperations, 1);
  assert.equal(applied.length, 0);
  assert.equal(operation.runtime.agents.traex.model, undefined);
  await assert.rejects(
    runtime.acquire(changed("latest")),
    /current work finishes/,
  );
  await operation.release();
  await operation.release();
  assert.equal(runtime.status().state, "applied");
  assert.equal(applied.length, 1);
  assert.equal(runtime.value().agents.traex.model, "latest");
});

test("readiness failure retains the old runtime, blocks new work and retries only on request", async () => {
  const cfg = initial();
  let fail = true,
    builds = 0;
  const runtime = new ConnectorRuntime(cfg, cfg, async (next) => {
    builds++;
    if (fail) throw new Error("native connection unavailable");
    return next;
  });
  const next = changed("candidate");
  assert.equal((await runtime.reload(next)).state, "failed");
  assert.equal(runtime.value(), cfg);
  await assert.rejects(runtime.acquire(next), /native connection unavailable/);
  assert.equal(builds, 1);
  fail = false;
  await runtime.reload(next, true);
  assert.equal(runtime.status().state, "applied");
  assert.equal(builds, 2);
  const lease = await runtime.acquire(next);
  assert.equal(lease.runtime.agents.traex.model, "candidate");
  await lease.release();
});

test("a configuration saved during readiness checks is applied before new work is admitted", async () => {
  const cfg = initial();
  const gate = Promise.withResolvers<void>();
  const models: string[] = [];
  const runtime = new ConnectorRuntime(cfg, cfg, async (next) => {
    models.push(next.agents.traex.model!);
    if (models.length === 1) await gate.promise;
    return next;
  });
  const first = runtime.reload(changed("first"));
  assert.equal(runtime.status().state, "applying");
  const latest = runtime.reload(changed("latest"));
  gate.resolve();
  await Promise.all([first, latest]);
  assert.deepEqual(models, ["first", "latest"]);
  assert.equal(runtime.status().state, "applied");
  assert.equal(runtime.value().agents.traex.model, "latest");
});
