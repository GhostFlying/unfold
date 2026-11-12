import test from "node:test";
import assert from "node:assert/strict";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
import { secret } from "../src/config.js";

test("event replay includes completion after more than one page of history", async () => {
  const f = fixture();
  const { review } = await seed(f.service);
  f.service.store.put("run", {
    id: "long-run",
    reviewId: review.id,
    state: "succeeded",
  });
  for (let i = 0; i < 600; i++)
    f.service.record("long-run", {
      type: "status",
      message: "synthetic source progress",
    });
  f.service.record("long-run", { type: "finished", state: "succeeded" });
  const app = await createServer(f.service, true);
  await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const port = (app.server.address() as any).port;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/runs/long-run/events`,
      {
        headers: { authorization: `Bearer ${secret(f.root, "owner-token")}` },
        signal: AbortSignal.timeout(5000),
      },
    );
    const reader = response.body!.getReader();
    let text = "";
    try {
      while (!text.includes('"type":"finished"')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } finally {
      await reader.cancel();
    }
    assert.ok(text.includes('"type":"finished"'));
    assert.equal((text.match(/synthetic source progress/g) || []).length, 600);
  } finally {
    await app.close();
    f.cleanup();
  }
});
