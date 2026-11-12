import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const cli = (args: string[], root: string) =>
  new Promise<{ exit: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const p = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "--json", ...args],
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
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        data: { requestedUrl: req.url, content: "fixed source" },
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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
