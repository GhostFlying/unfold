import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeUsageBaseline } from "../src/native-usage.js";
test("resumed native usage falls back only to this dedicated thread receipt with consistent fields", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "unfold-usage-baseline-"));
  try {
    const file = path.join(root, "thread.jsonl");
    const counts = {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 4,
      total_tokens: 120,
    };
    const line = (thread: string, u: any) =>
      JSON.stringify({
        type: "token_usage_record",
        payload: { thread_id: thread, thread_token_usage: u },
      }) + "\n";
    writeFileSync(
      file,
      line("owned", counts) +
        line("other", { ...counts, input_tokens: 500, total_tokens: 520 }) +
        line("owned", { ...counts, input_tokens: 0 }),
    );
    assert.deepEqual(nativeUsageBaseline(root, file, "owned"), {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 4,
      totalTokens: 120,
    });
    assert.equal(
      nativeUsageBaseline(path.join(root, "other"), file, "owned"),
      undefined,
    );
    assert.equal(nativeUsageBaseline(root, file, "unknown"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
