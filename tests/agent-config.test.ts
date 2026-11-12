import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelProfile } from "../src/agent.js";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
import { readFileSync } from "node:fs";
import { loadConfig, saveConfig, secret } from "../src/config.js";

test("model metadata controls supported efforts without silent coercion", () => {
  const models = [
    {
      id: "reasoner",
      model: "model-a",
      displayName: "Reasoner",
      isDefault: true,
      defaultEffort: "medium",
      efforts: [
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
      ],
    },
  ];
  assert.deepEqual(resolveModelProfile(models, {}), {
    model: "model-a",
    effort: "medium",
  });
  assert.deepEqual(
    resolveModelProfile(models, { model: "reasoner", effort: "high" }),
    { model: "model-a", effort: "high" },
  );
  assert.throws(
    () => resolveModelProfile(models, { model: "invented" }),
    /advertised/,
  );
  assert.throws(
    () => resolveModelProfile(models, { model: "model-a", effort: "ultra" }),
    /does not advertise/,
  );
});

test("global and review profiles inherit, clear independently, and reject unsupported effort atomically", async () => {
  const f = fixture();
  const { review } = await seed(f.service);
  const app = await createServer(f.service, true);
  const headers = {
    authorization: `Bearer ${secret(f.root, "owner-token")}`,
    "content-type": "application/json",
  };
  const patch = (url: string, payload: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1${url}`,
      payload: payload as any,
      headers,
    });
  try {
    const global = await patch("/config", {
      agents: {
        traex: {
          ...f.service.config.agents.traex,
          model: "test-model",
          effort: "medium",
        },
      },
    });
    assert.equal(global.statusCode, 200, global.body);
    assert.equal(global.json().data.restartConnectorRequired, false);
    assert.equal(
      (
        await app.inject({ url: `/api/v1/reviews/${review.id}/agent`, headers })
      ).json().data.profiles.traex.effort,
      "medium",
    );
    assert.equal(
      (
        await patch(`/reviews/${review.id}`, {
          agentOverrides: { traex: { effort: "high" } },
        })
      ).statusCode,
      200,
    );
    const bad = await patch(`/reviews/${review.id}`, {
      agentOverrides: { traex: { effort: "ultra" } },
    });
    assert.equal(bad.statusCode, 422);
    assert.equal(
      f.service.review(review.id).agentOverrides?.traex?.effort,
      "high",
    );
    await patch("/config", { defaultBackend: "codex" });
    assert.equal(f.service.review(review.id).backend, "codex");
    await patch(`/reviews/${review.id}`, { backend: "traex" });
    assert.equal(f.service.review(review.id).backend, "traex");
    assert.equal(
      f.service.review(review.id).agentOverrides?.traex?.effort,
      "high",
    );
    await patch(`/reviews/${review.id}`, {
      backend: null,
      agentOverrides: { traex: { effort: null } },
    });
    const resolved = (
      await app.inject({ url: `/api/v1/reviews/${review.id}/agent`, headers })
    ).json().data;
    assert.equal(resolved.backend, "codex");
    assert.equal(resolved.profiles.traex.effort, "medium");
    assert.equal(
      (await app.inject(`/api/v1/agents/traex/models`)).statusCode,
      401,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});

test("container overrides do not replace persisted host paths when saving defaults", () => {
  const f = fixture();
  const keys = [
    "UNFOLD_DATA_DIR",
    "UNFOLD_CONNECTOR_SOCKET",
    "UNFOLD_OWNER_PORT",
    "UNFOLD_SHARE_PORT",
    "UNFOLD_SHARE_LISTEN",
  ];
  const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    saveConfig(f.service.config);
    process.env.UNFOLD_DATA_DIR = "/container/data";
    process.env.UNFOLD_CONNECTOR_SOCKET = "/container/connector.sock";
    process.env.UNFOLD_OWNER_PORT = "8081";
    process.env.UNFOLD_SHARE_PORT = "8080";
    process.env.UNFOLD_SHARE_LISTEN = "0.0.0.0";
    const config = loadConfig();
    config.agents.traex.effort = "high";
    saveConfig(config);
    const saved = JSON.parse(readFileSync(f.root + "/config.json", "utf8"));
    assert.equal(saved.dataDir, f.service.config.dataDir);
    assert.equal(saved.socketPath, f.service.config.socketPath);
    assert.equal(saved.ownerPort, f.service.config.ownerPort);
    assert.equal(saved.agents.traex.effort, "high");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    f.cleanup();
  }
});
