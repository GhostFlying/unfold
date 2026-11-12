import test from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { ArtifactDraft } from "../src/artifact-draft.js";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
import { secret } from "../src/config.js";
import type { Run } from "../src/types.js";

test("private numbered parts assemble in order, replace idempotently, survive reopening and reject gaps or version changes", async () => {
  const f = fixture();
  try {
    const { explanation } = await seed(f.service);
    const draft = new ArtifactDraft(
      f.service.config.dataDir,
      "segmented-run",
      explanation.versionId,
    );
    const save = (
      kind: "overview" | "guide" | "html",
      index: number,
      content: string,
    ) => draft.save({ kind, index, content }, explanation.references);
    save(
      "overview",
      1,
      JSON.stringify({ title: "A change", summary: "Verified source" }),
    );
    save("guide", 1, JSON.stringify(explanation.guide!.groups[0]));
    save("html", 2, "<p>Second</p>");
    assert.throws(() => draft.assemble(), /non-contiguous/);
    save("html", 1, "<h1>First</h1>");
    const writes = draft.read().writes;
    save("html", 1, "<h1>First</h1>");
    assert.equal(draft.read().writes, writes);
    save("html", 1, "<h1>Revised</h1>");
    const reopened = new ArtifactDraft(
      f.service.config.dataDir,
      "segmented-run",
      explanation.versionId,
    );
    assert.equal(reopened.assemble().html, "<h1>Revised</h1><p>Second</p>");
    assert.equal(reopened.progress().savedParts, 4);
    assert.equal(
      reopened.read().references[0].id,
      explanation.references[0].id,
    );
    assert.ok(!("content" in reopened.read().parts[0]));
    assert.ok("content" in reopened.read(true).parts[0]);
    assert.throws(
      () =>
        new ArtifactDraft(
          f.service.config.dataDir,
          "segmented-run",
          "another-version",
        ).read(),
      /another source version/,
    );
    assert.throws(
      () => new ArtifactDraft(f.service.config.dataDir, "../owner-token", "v"),
      /identity/,
    );
    for (const input of [
      { kind: "html", index: 0, content: "x" },
      { kind: "html", index: 257, content: "x" },
      { kind: "html", index: 1, content: "x".repeat(16001) },
      { kind: "overview", index: 2, content: "{}" },
      { kind: "guide", index: 17, content: "{}" },
      { kind: "html", index: 1, content: "x", path: "../token" },
    ])
      assert.throws(() => draft.save(input, []));
    const part = reopened.read().parts.find((p) => p.kind === "html")!;
    const file = `${f.service.config.dataDir}/artifacts/in-progress/segmented-run/html-${part.index}.txt.${part.sha256}`;
    assert.equal(statSync(file).mode & 0o777, 0o600);
    writeFileSync(file, "tampered");
    assert.throws(() => reopened.assemble(), /integrity/);
  } finally {
    f.cleanup();
  }
});

test("partial artifact reads are owner-only, remain private after failure and retain source/run identity", async () => {
  const f = fixture();
  const { review, explanation } = await seed(f.service);
  const run: Run = {
    id: "failed-parts",
    reviewId: review.id,
    versionId: review.versionId,
    kind: "analysis",
    state: "failed",
    backend: "traex",
    createdAt: new Date().toISOString(),
  };
  f.service.store.put("run", run);
  const draft = new ArtifactDraft(
    f.service.config.dataDir,
    run.id,
    run.versionId,
  );
  draft.save({ kind: "html", index: 1, content: "PRIVATE-PART-SENTINEL" }, []);
  const owner = await createServer(f.service, true),
    viewer = await createServer(f.service, false);
  const endpoint = `/api/v1/runs/${run.id}/artifact`;
  try {
    assert.equal((await owner.inject(endpoint)).statusCode, 401);
    assert.equal(
      (await viewer.inject(endpoint + "?content=1")).statusCode,
      404,
    );
    const headers = {
      authorization: `Bearer ${secret(f.root, "owner-token")}`,
    };
    const summary = await owner.inject({ url: endpoint, headers });
    assert.equal(summary.statusCode, 200, summary.body);
    assert.equal(summary.json().data.runId, run.id);
    assert.equal(summary.json().data.versionId, run.versionId);
    assert.ok(!summary.body.includes("PRIVATE-PART-SENTINEL"));
    const content = await owner.inject({
      url: endpoint + "?content=1",
      headers,
    });
    assert.equal(content.json().data.parts[0].content, "PRIVATE-PART-SENTINEL");
    assert.equal(f.service.bundle(review.id).explanation?.id, explanation.id);
    assert.ok(
      !(await viewer.inject(`/api/v1/reviews/${review.id}`)).body.includes(
        "PRIVATE-PART-SENTINEL",
      ),
    );
  } finally {
    await Promise.all([owner.close(), viewer.close()]);
    f.cleanup();
  }
});
