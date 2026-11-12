import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { connectorStream } from "../src/rpc.js";
import { AgentHost } from "../src/agent.js";
import { Providers } from "../src/providers.js";
import { testConfig } from "./fixtures.js";
test("a streamed failure becomes a rejected operation instead of an unhandled socket error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-rpc-")),
    socket = path.join(root, "test.sock");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.end(
      JSON.stringify({ type: "failure", message: "deliberate test failure" }) +
        "\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    await assert.rejects(
      connectorStream(
        socket,
        "test",
        {},
        () => {
          throw new Error("deliberate test failure");
        },
        new AbortController().signal,
      ),
      /deliberate test failure/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test("execution decisions require the pending exact digest and are consumed once", () => {
  const cfg = testConfig("/tmp/unfold-digest-test"),
    host = new AgentHost(cfg, "/tmp/unfold-digest-test", new Providers(cfg));
  let result = false;
  host.approvals.set("approval-test", {
    runId: "run-test",
    digest: "exact-digest",
    resolve: (approved) => {
      result = approved;
    },
  });
  assert.throws(
    () => host.decide("approval-test", "another-digest", true),
    /changed/,
  );
  assert.equal(result, false);
  host.decide("approval-test", "exact-digest", true);
  assert.equal(result, true);
  assert.throws(
    () => host.decide("approval-test", "exact-digest", true),
    /no longer pending/,
  );
});
