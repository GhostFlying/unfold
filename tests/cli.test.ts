import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const cli = (args: string[], root: string, json = true) =>
  new Promise<{ exit: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const p = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", ...(json ? ["--json"] : []), ...args],
        {
          env: { ...process.env, UNFOLD_HOME: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      p.stdout.on("data", (b) => (stdout += b));
      p.stderr.on("data", (b) => (stderr += b));
      p.on("close", (exit) => resolve({ exit, stdout, stderr }));
    },
  );
test("CLI keeps subcommand --version distinct and parses errors as stable JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-cli-"));
  await writeFile(path.join(root, "owner-token"), "synthetic-key");
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        data: {
          requestedUrl: req.url,
          content: "fixed source",
          text: "Review background\n\n@runtime · src/：move cancellation earlier\n\n完整讲解：https://review.example.test/r/r/v/e",
          body: body ? JSON.parse(body) : undefined,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    const r = await cli(
      [
        "--server",
        `http://127.0.0.1:${port}`,
        "source",
        "review-id",
        "src/test.ts",
        "--version",
        "immutable-version",
      ],
      root,
    );
    assert.equal(r.exit, 0, r.stderr);
    assert.match(
      JSON.parse(r.stdout).data.requestedUrl,
      /versionId=immutable-version/,
    );
    const missing = await cli(["source", "review-id", "src/test.ts"], root);
    assert.equal(missing.exit, 2);
    assert.equal(JSON.parse(missing.stderr).error.code, "invalid_input");
    const bad = await cli(["invented-command"], root);
    assert.equal(bad.exit, 2);
    assert.equal(JSON.parse(bad.stderr).error.code, "invalid_input");
    const run = await cli(
      ["--server", `http://127.0.0.1:${port}`, "run", "durable-run"],
      root,
    );
    assert.equal(run.exit, 0, run.stderr);
    assert.equal(
      JSON.parse(run.stdout).data.requestedUrl,
      "/api/v1/runs/durable-run",
    );
    for (const [args, expected] of [
      [
        ["guide", "r", "--owner", "runtime"],
        "/api/v1/reviews/r/guide?owner=runtime",
      ],
      [
        ["guide", "r", "--path", "src/native"],
        "/api/v1/reviews/r/guide?path=src%2Fnative",
      ],
      [
        ["share", "r", "--owner", "runtime"],
        "/api/v1/reviews/r/share?owner=runtime",
      ],
      [
        ["review-summary", "r", "--explanation", "e1"],
        "/api/v1/reviews/r/review-summary?explanationId=e1",
      ],
      [
        ["owners", "r", "--refresh", "--version", "v1"],
        "/api/v1/reviews/r/owners/refresh",
      ],
    ] as [string[], string][]) {
      const result = await cli(
        ["--server", `http://127.0.0.1:${port}`, ...args],
        root,
      );
      assert.equal(result.exit, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).data.requestedUrl, expected);
    }
    const activity = await cli(
      ["--server", `http://127.0.0.1:${port}`, "activity"],
      root,
    );
    assert.equal(activity.exit, 0, activity.stderr);
    assert.equal(
      JSON.parse(activity.stdout).data.requestedUrl,
      "/api/v1/activity",
    );
    const summaryText = await cli(
      ["--server", `http://127.0.0.1:${port}`, "review-summary", "r"],
      root,
      false,
    );
    assert.equal(summaryText.exit, 0, summaryText.stderr);
    assert.equal(
      summaryText.stdout,
      "Review background\n\n@runtime · src/：move cancellation earlier\n\n完整讲解：https://review.example.test/r/r/v/e\n",
    );
    const artifact = await cli(
      [
        "--server",
        `http://127.0.0.1:${port}`,
        "artifact",
        "failed-run",
        "--content",
      ],
      root,
    );
    assert.equal(artifact.exit, 0, artifact.stderr);
    assert.equal(
      JSON.parse(artifact.stdout).data.requestedUrl,
      "/api/v1/runs/failed-run/artifact?content=1",
    );
    for (const [flag, expected] of [
      ["--effort", "high"],
      ["--model-default-effort", null],
    ] as const) {
      const generated = await cli(
        [
          "--server",
          `http://127.0.0.1:${port}`,
          "analyze",
          "review-id",
          "--backend",
          "codex",
          "--model",
          "test-model",
          flag,
          ...(expected ? [expected] : []),
        ],
        root,
      );
      assert.equal(generated.exit, 0, generated.stderr);
      assert.deepEqual(JSON.parse(generated.stdout).data.body, {
        backend: "codex",
        model: "test-model",
        effort: expected,
      });
    }
    const conflict = await cli(
      ["analyze", "review-id", "--effort", "high", "--model-default-effort"],
      root,
    );
    assert.equal(conflict.exit, 2);
    assert.equal(JSON.parse(conflict.stderr).error.code, "invalid_input");
    const persistent = await cli(
      [
        "--server",
        `http://127.0.0.1:${port}`,
        "agent",
        "set",
        "review-id",
        "--backend",
        "traex",
        "--model",
        "plain-model",
        "--model-default-effort",
      ],
      root,
    );
    assert.equal(persistent.exit, 0, persistent.stderr);
    assert.deepEqual(JSON.parse(persistent.stdout).data.body, {
      backend: "traex",
      agentOverrides: {
        traex: { model: "plain-model", modelDefaultEffort: true },
      },
    });
    for (const flag of ["--inherit-effort", "--effort"]) {
      const invalid = await cli(
        [
          "agent",
          "set",
          "review-id",
          "--backend",
          "traex",
          "--model-default-effort",
          flag,
          ...(flag === "--effort" ? ["high"] : []),
        ],
        root,
      );
      assert.equal(invalid.exit, 2);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
