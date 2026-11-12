import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelProfile } from "../src/agent.js";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
import { readFileSync } from "node:fs";
import { loadConfig, saveConfig, secret } from "../src/config.js";
import type { Run, Review } from "../src/types.js";

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
  assert.deepEqual(
    resolveModelProfile(
      [
        {
          id: "plain",
          model: "plain",
          displayName: "Plain",
          defaultEffort: "high",
          efforts: [],
        },
      ],
      {},
    ),
    { model: "plain", effort: undefined },
  );
});

test("MR model-default effort bypasses inherited effort, persists across reads and applies to analysis and questions", async () => {
  const f = fixture();
  const { review } = await seed(f.service);
  f.service.config.agents.traex.effort = "high";
  const app = await createServer(f.service, true);
  const headers = { authorization: `Bearer ${secret(f.root, "owner-token")}` };
  const patch = (profile: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/reviews/${review.id}`,
      headers,
      payload: { agentOverrides: { traex: profile } },
    });
  try {
    for (const [model, expected] of [
      ["fast-model", "low"],
      ["plain-model", undefined],
    ] as const) {
      const saved = await patch({
        model,
        effort: null,
        modelDefaultEffort: true,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const settings = (
        await app.inject({ url: `/api/v1/reviews/${review.id}/agent`, headers })
      ).json().data;
      assert.equal(settings.overrides.traex.modelDefaultEffort, true);
      assert.equal(settings.profiles.traex.effort, undefined);
      for (const kind of ["analyze", "questions"]) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/reviews/${review.id}/${kind}`,
          headers,
          payload: kind === "questions" ? { question: "Check" } : {},
        });
        assert.equal(response.statusCode, 200, response.body);
        const run = response.json().data;
        assert.equal(run.model, model);
        assert.equal(run.effort, expected);
        assert.equal(run.requestedProfile.effort, undefined);
        await f.service.tasks.get(run.id);
      }
    }
    assert.equal(
      (await patch({ model: "test-model", effort: null })).statusCode,
      200,
    );
    assert.equal(
      f.service.review(review.id).agentOverrides?.traex?.modelDefaultEffort,
      undefined,
    );
    assert.equal((await patch({ effort: "ultra" })).statusCode, 422);
    assert.equal(f.service.config.agents.traex.effort, "high");
  } finally {
    await app.close();
    f.cleanup();
  }
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
    assert.equal(global.json().data.application.state, "applied");
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
test("per-generation profiles and explicit model-default effort preserve global/MR defaults and previous explanations", async () => {
  const f = fixture();
  const { review, explanation } = await seed(f.service);
  f.service.config.agents.codex = {
    ...f.service.config.agents.codex,
    model: "test-model",
    effort: "high",
  };
  const savedReview = f.service.store.get<Review>("review", review.id);
  savedReview.agentOverrides = {
    codex: { model: "test-model", effort: "high" },
  };
  f.service.store.put("review", savedReview);
  const originalConfig = structuredClone(f.service.config);
  const app = await createServer(f.service, true);
  const headers = {
    authorization: `Bearer ${secret(f.root, "owner-token")}`,
    "content-type": "application/json",
  };
  try {
    for (const [effort, expected] of [
      ["high", "high"],
      [null, "medium"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/reviews/${review.id}/analyze`,
        headers,
        payload: { backend: "codex", model: "test-model", effort },
      });
      assert.equal(response.statusCode, 200, response.body);
      const run = response.json().data as Run;
      assert.equal(run.backend, "codex");
      assert.equal(run.model, "test-model");
      assert.equal(run.effort, expected);
      await f.service.tasks.get(run.id);
      assert.deepEqual(f.service.config, originalConfig);
      assert.deepEqual(f.service.store.get("review", review.id), savedReview);
      assert.equal(f.service.bundle(review.id).explanation?.id, explanation.id);
    }
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${review.id}/analyze`,
      headers,
      payload: { backend: "codex", model: "test-model", effort: "ultra" },
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.code, "unsupported_effort");
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

test("unchanged form fields apply automatically without redundant model checks", async () => {
  const f = fixture();
  const app = await createServer(f.service, true);
  const headers = {
    authorization: `Bearer ${secret(f.root, "owner-token")}`,
    "content-type": "application/json",
  };
  try {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/config",
      headers,
      payload: {
        codebaseHosts: [...f.service.config.codebaseHosts],
        agents: structuredClone(f.service.config.agents),
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.application.state, "applied");
    assert.equal(f.service.modelQueries, 0);
    assert.equal(f.service.reloads, 1);
    assert.ok(!response.body.includes("restartConnectorRequired"));
    f.service.application = { state: "pending", activeOperations: 1 };
    const pending = await app.inject({
      method: "PATCH",
      url: "/api/v1/config",
      headers,
      payload: { codebaseHosts: ["another.example.test"] },
    });
    assert.equal(pending.json().data.application.state, "pending");
    assert.equal(pending.json().data.saved, true);
    f.service.application = {
      state: "failed",
      error: "Synthetic connection unavailable",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/config/apply",
          headers,
          payload: {},
        })
      ).json().data.state,
      "failed",
    );
    assert.equal((await app.inject("/api/v1/config/status")).statusCode, 401);
    assert.equal(
      (await app.inject({ url: "/api/v1/config/status", headers })).json().data
        .state,
      "failed",
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
