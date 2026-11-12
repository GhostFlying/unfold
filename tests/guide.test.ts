import test from "node:test";
import assert from "node:assert/strict";
import { validateGuide } from "../src/guide.js";
import { fixture, seed, snapshot } from "./fixtures.js";
import { createServer } from "../src/server.js";

test("guide validates exact changed paths, source references, coverage and stable point IDs", async () => {
  const f = fixture();
  try {
    const { explanation } = await seed(f.service);
    const result = validateGuide(
      explanation.guide,
      snapshot,
      explanation.references,
    );
    assert.equal(result.groups[0].id, "g1");
    assert.equal(result.groups[1].points[0].id, "g2-c1");
    const invalidRef = structuredClone(result);
    invalidRef.groups[0].points[0].referenceIds = ["invented-reference"];
    assert.throws(
      () => validateGuide(invalidRef, snapshot, explanation.references),
      /unverified/,
    );
    const invalidFile = structuredClone(result);
    invalidFile.groups[0].points[0].files = ["../credentials"];
    assert.throws(
      () => validateGuide(invalidFile, snapshot, explanation.references),
      /unverified/,
    );
    const expanded = {
      ...snapshot,
      files: [
        ...snapshot.files,
        {
          ...snapshot.files[0],
          path: "src/another.ts",
          oldPath: "src/another.ts",
        },
      ],
    };
    assert.throws(
      () => validateGuide(result, expanded, explanation.references),
      /all changed files/,
    );
    const renamed = {
      ...snapshot,
      files: [{ ...snapshot.files[0], oldPath: "src/old-queue.ts" }],
    };
    assert.equal(
      validateGuide(result, renamed, explanation.references).groups.length,
      2,
    );
  } finally {
    f.cleanup();
  }
});

test("persisted guides are public reads with version-bound point filtering and explicit legacy absence", async () => {
  const f = fixture();
  const { review, explanation } = await seed(f.service);
  const viewer = await createServer(f.service, false);
  try {
    const endpoint = `/api/v1/reviews/${review.id}/guide`;
    const whole = await viewer.inject(endpoint);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.json().data.groups.length, 2);
    assert.ok(!whole.body.includes(explanation.threadId));
    const point = await viewer.inject(endpoint + "?point=g2-c1");
    assert.equal(point.json().data.groups[0].points[0].id, "g2-c1");
    assert.equal(point.json().data.versionId, explanation.versionId);
    assert.equal(
      (await viewer.inject(endpoint + "?point=made-up")).statusCode,
      404,
    );
    assert.equal(
      (await viewer.inject(`/api/v1/runs/private-run`)).statusCode,
      404,
    );
    delete explanation.guide;
    f.service.store.put("explanation", explanation);
    const legacy = await viewer.inject(endpoint);
    assert.equal(legacy.json().error.code, "guide_unavailable");
    assert.equal(
      f.service.bundle(review.id).explanation?.html,
      explanation.html,
    );
  } finally {
    await viewer.close();
    f.cleanup();
  }
});
