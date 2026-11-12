import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  seed,
  snapshot,
  target,
  FakeService,
  testConfig,
} from "./fixtures.js";
import { safePath } from "../src/util.js";
import { parseTarget } from "../src/providers.js";
import { shareUrl, secret } from "../src/config.js";
import { createServer } from "../src/server.js";
import { validateAnchor } from "../src/diff.js";
import type { Approval, Draft, Run } from "../src/types.js";

test("only configured source hosts and repository-relative references are accepted", () => {
  const f = fixture();
  try {
    assert.equal(
      parseTarget(target.url, f.service.config).repo,
      "sample/queue",
    );
    for (const url of [
      "https://evil.example/sample/queue/merge_requests/42",
      "file:///etc/passwd",
      "https://user:secret@code.example.test/sample/queue/merge_requests/42",
    ])
      assert.throws(() => parseTarget(url, f.service.config));
    for (const unsafe of [
      "../secret",
      "/etc/passwd",
      "src/../../secret",
      ".git/config",
      "--revision",
    ])
      assert.throws(() => safePath(unsafe));
    for (const host of [
      "http://localhost:1234",
      "http://127.0.0.1:1234",
      "https://machine.tailnet.ts.net",
      "http://100.120.1.2:1234",
    ])
      assert.throws(() =>
        shareUrl({ ...f.service.config, shareBaseUrl: host }, "test"),
      );
    assert.equal(
      shareUrl(f.service.config, "stable-id"),
      "https://review.example.test/r/stable-id",
    );
  } finally {
    f.cleanup();
  }
});
test("concurrent duplicate imports preserve one review and valid version ownership", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([
      f.service.import(target.url),
      f.service.import(target.url),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.service.version(a.id).head, snapshot.head);
    assert.equal(f.service.store.list("review").length, 1);
  } finally {
    f.cleanup();
  }
});
test("viewer listener has no owner mutations, private routes or native session identifiers", async () => {
  const f = fixture();
  const { review } = await seed(f.service);
  const app = await createServer(f.service, false);
  try {
    const publicResponse = await app.inject(`/api/v1/reviews/${review.id}`);
    assert.equal(publicResponse.statusCode, 200);
    assert.ok(!publicResponse.body.includes("private-thread-id"));
    for (const endpoint of [
      "/config",
      "/approvals",
      `/reviews/${review.id}/runs`,
      `/reviews/${review.id}/drafts`,
    ])
      assert.equal((await app.inject("/api/v1" + endpoint)).statusCode, 404);
    const result = await app.inject({
      method: "POST",
      url: `/api/v1/reviews/${review.id}/analyze`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret(f.root, "owner-token")}`,
      },
      payload: {},
    });
    assert.equal(result.statusCode, 404);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("owner endpoints reject unauthenticated and cross-origin writes", async () => {
  const f = fixture();
  const { review } = await seed(f.service);
  const app = await createServer(f.service, true);
  try {
    assert.equal((await app.inject("/api/v1/config")).statusCode, 401);
    const headers = {
      authorization: `Bearer ${secret(f.root, "owner-token")}`,
      "content-type": "application/json",
    };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/reviews/${review.id}/drafts`,
          headers: { ...headers, origin: "https://attacker.example" },
          payload: { body: "test" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/reviews/${review.id}/drafts`,
          headers,
          payload: { body: "test" },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("private investigation cache does not become shared source evidence", async () => {
  const f = fixture();
  try {
    const { review } = await seed(f.service);
    await f.service.source(
      review.id,
      snapshot.id,
      "private/context.ts",
      "new",
      true,
    );
    await assert.rejects(
      f.service.source(
        review.id,
        snapshot.id,
        "private/context.ts",
        "new",
        false,
      ),
      /shared explanation evidence/,
    );
    assert.equal(
      (
        await f.service.source(
          review.id,
          snapshot.id,
          "src/queue.ts",
          "new",
          false,
        )
      ).path,
      "src/queue.ts",
    );
  } finally {
    f.cleanup();
  }
});
test("inline mapping respects old/new sides and rejects missing or truncated diff lines", async () => {
  const f = fixture();
  try {
    const { reference } = await seed(f.service);
    validateAnchor(snapshot, reference);
    const renamed = {
      ...snapshot,
      files: [
        {
          ...snapshot.files[0],
          path: "src/new-queue.ts",
          oldPath: "src/old-queue.ts",
        },
      ],
    };
    validateAnchor(renamed, {
      ...reference,
      path: "src/old-queue.ts",
      side: "old",
      commit: snapshot.base,
      start: 2,
      end: 2,
    });
    assert.throws(
      () =>
        validateAnchor(renamed, {
          ...reference,
          path: "src/new-queue.ts",
          side: "old",
          commit: snapshot.base,
        }),
      /cannot be mapped/,
    );
    const deleted = {
      ...snapshot,
      files: [
        {
          ...snapshot.files[0],
          patch: "@@ -1,2 +0,0 @@\n-first\n-second",
          added: 0,
          deleted: 2,
        },
      ],
    };
    validateAnchor(deleted, {
      ...reference,
      side: "old",
      commit: snapshot.base,
      start: 2,
      end: 2,
    });
    assert.throws(
      () => validateAnchor(deleted, reference),
      /outside the current diff/,
    );

    assert.throws(
      () => validateAnchor(snapshot, { ...reference, start: 90, end: 90 }),
      /outside the current diff/,
    );
    assert.throws(
      () =>
        validateAnchor(
          {
            ...snapshot,
            files: snapshot.files.map((s) => ({ ...s, truncated: true })),
          },
          reference,
        ),
      /cannot be mapped/,
    );
    assert.throws(
      () => validateAnchor(snapshot, { ...reference, commit: "newer" }),
      /commit/,
    );
  } finally {
    f.cleanup();
  }
});
test("a preview must match exact content and newest immutable commit before publishing", async () => {
  const f = fixture();
  try {
    const { review, reference } = await seed(f.service);
    const draft = f.service.createDraft(
      review.id,
      "Could this guard skip cleanup?",
      reference.id,
    );
    const preview = f.service.preview(draft.id);
    await assert.rejects(f.service.publish(draft.id, "wrong"), /exact content/);
    f.service.editDraft(
      draft.id,
      "Could cancellation skip cleanup in this path?",
      1,
    );
    await assert.rejects(
      f.service.publish(draft.id, preview.digest),
      /exact content/,
    );
    const updated = f.service.preview(draft.id);
    f.service.current = {
      ...f.service.current,
      id: "version-two",
      head: "c".repeat(40),
    };
    await assert.rejects(
      f.service.publish(draft.id, updated.digest),
      /MR changed/,
    );
    assert.equal(f.service.writes, 0);
  } finally {
    f.cleanup();
  }
});
test("concurrent publication cannot duplicate a comment, and published retry is idempotent", async () => {
  const f = fixture();
  try {
    const { review, reference } = await seed(f.service);
    const d = f.service.createDraft(
        review.id,
        "Synthetic test comment",
        reference.id,
      ),
      preview = f.service.preview(d.id);
    f.service.writeDelay = 20;
    const results = await Promise.allSettled([
      f.service.publish(d.id, preview.digest),
      f.service.publish(d.id, preview.digest),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.service.writes, 1);
    assert.equal(
      (await f.service.publish(d.id, preview.digest)).state,
      "published",
    );
    assert.equal(f.service.writes, 1);
  } finally {
    f.cleanup();
  }
});
test("transport ambiguity stays unknown until platform readback finds the publication marker", async () => {
  const f = fixture();
  try {
    const { review } = await seed(f.service),
      d = f.service.createDraft(review.id, "Synthetic test comment");
    f.service.uncertain = true;
    const p = await f.service.publish(d.id, f.service.preview(d.id).digest);
    assert.equal(p.state, "unknown");
    await assert.rejects(f.service.publish(d.id, "ignored"), /Reconcile/);
    assert.throws(
      () => f.service.editDraft(d.id, "Try again", 1),
      /no longer editable/,
    );
    assert.equal((await f.service.reconcile(d.id)).state, "published");
    assert.equal(f.service.writes, 1);
  } finally {
    f.cleanup();
  }
});
test("an explicitly converted general comment moves to the current version", async () => {
  const f = fixture();
  try {
    const { review, reference } = await seed(f.service),
      d = f.service.createDraft(review.id, "Design question", reference.id);
    f.service.current = {
      ...f.service.current,
      id: "version-two",
      head: "c".repeat(40),
    };
    await f.service.refresh(review.id);
    assert.throws(() => f.service.preview(d.id), /relocate/);
    f.service.editDraft(d.id, "General design question", 1, true);
    assert.equal(f.service.preview(d.id).versionId, "version-two");
    assert.equal(f.service.preview(d.id).kind, "general");
  } finally {
    f.cleanup();
  }
});
test("restart preserves stable review/history/drafts, interrupts work, and never replays publishing", async () => {
  const f = fixture();
  try {
    const { review } = await seed(f.service);
    const d = f.service.createDraft(review.id, "Saved draft");
    const run: Run = {
      id: "pending-run",
      reviewId: review.id,
      versionId: snapshot.id,
      kind: "analysis",
      state: "running",
      backend: "traex",
      createdAt: snapshot.fetchedAt,
    };
    f.service.store.put("run", run);
    const uncertain: Draft = {
      ...d,
      id: "publishing-draft",
      state: "publishing",
      publicationId: "publication-before-restart",
    };
    f.service.store.put("draft", uncertain);
    f.service.store.close();
    const recovered = new FakeService(testConfig(f.root));
    assert.equal((await recovered.import(target.url)).id, review.id);
    assert.equal(recovered.store.get<Run>("run", run.id).state, "interrupted");
    assert.equal(recovered.store.get<Draft>("draft", d.id).body, "Saved draft");
    assert.equal(
      recovered.store.get<Draft>("draft", uncertain.id).state,
      "unknown",
    );
    assert.equal(
      recovered.bundle(review.id).explanation?.id,
      "explanation-one",
    );
    assert.equal(recovered.writes, 0);
    recovered.store.close();
  } finally {
    try {
      f.cleanup();
    } catch {}
  }
});

test("unpublished investigations are not exposed to visitors who know the review ID", async () => {
  const f = fixture();
  const r = await f.service.import(target.url);
  const app = await createServer(f.service, false);
  try {
    for (const suffix of ["", "/snapshot", "/versions", "/history", "/share"])
      assert.equal(
        (await app.inject(`/api/v1/reviews/${r.id}${suffix}`)).statusCode,
        404,
      );
  } finally {
    await app.close();
    f.cleanup();
  }
});

test("a partial publication failure retains each comment's independent outcome", async () => {
  const f = fixture();
  try {
    const { review } = await seed(f.service);
    const first = f.service.createDraft(review.id, "First confirmed comment");
    const second = f.service.createDraft(review.id, "Second confirmed comment");
    const one = await f.service.publish(
      first.id,
      f.service.preview(first.id).digest,
    );
    f.service.uncertain = true;
    const two = await f.service.publish(
      second.id,
      f.service.preview(second.id).digest,
    );
    assert.equal(one.state, "published");
    assert.ok(one.remoteId);
    assert.equal(two.state, "unknown");
    assert.equal(
      f.service.store.get<Draft>("draft", first.id).remoteId,
      one.remoteId,
    );
    const reconciled = await f.service.reconcile(second.id);
    assert.equal(reconciled.state, "published");
    assert.notEqual(reconciled.remoteId, one.remoteId);
    assert.equal(f.service.writes, 2);
  } finally {
    f.cleanup();
  }
});
