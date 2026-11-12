import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { tokenCounts } from "./telemetry.js";
import type { TokenCounts } from "./types.js";

// Some restored native snapshots retain only totalTokens, zeroing the other
// fields. Recover a complete baseline from this dedicated thread's own native
// receipt, without querying a model or scanning unrelated history.
export function nativeUsageBaseline(
  home: string,
  file: unknown,
  threadId: string,
): TokenCounts | undefined {
  if (typeof file !== "string") return;
  let fd: number | undefined;
  try {
    const resolved = realpathSync(file);
    if (
      !resolved.startsWith(realpathSync(home) + path.sep) ||
      !resolved.endsWith(".jsonl")
    )
      return;
    fd = openSync(resolved, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return;
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    const offset = stat.size - size;
    const bytes = readSync(fd, buffer, 0, size, offset);
    let text = buffer.toString("utf8", 0, bytes);
    if (offset) text = text.slice(text.indexOf("\n") + 1);
    let latest: TokenCounts | undefined;
    for (const line of text.split("\n")) {
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const p = row.payload;
      if (row.type !== "token_usage_record" || p?.thread_id !== threadId)
        continue;
      const u = p.thread_token_usage;
      const counts = tokenCounts(
        u && {
          inputTokens: u.input_tokens,
          cachedInputTokens: u.cached_input_tokens,
          outputTokens: u.output_tokens,
          reasoningOutputTokens: u.reasoning_output_tokens,
          totalTokens: u.total_tokens,
        },
      );
      if (counts) latest = counts;
    }
    return latest;
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
