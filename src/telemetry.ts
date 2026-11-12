import type { AgentEvent, Run, RunProgress, TokenCounts } from "./types.js";

export function applyRunEvent(run: Run, event: AgentEvent): Run {
  if (typeof event.seq === "number") {
    if (event.seq <= (run.eventSeq || 0)) return run;
    run = { ...run, eventSeq: event.seq };
  }
  const at = typeof event.at === "string" ? event.at : new Date().toISOString();
  if (event.type === "status" && typeof event.message === "string") {
    const progress: RunProgress = {
      ...run.progress,
      stage: (event.stage || "investigating") as RunProgress["stage"],
      message: event.message,
      at,
      source: event.source === "agent" ? "agent" : "host",
      ...(typeof event.toolCalls === "number"
        ? { toolCalls: event.toolCalls }
        : {}),
      ...(typeof event.filesRead === "number"
        ? { filesRead: event.filesRead }
        : {}),
      ...(typeof event.outputChars === "number"
        ? { outputChars: event.outputChars }
        : {}),
      ...(typeof event.savedParts === "number"
        ? { savedParts: event.savedParts }
        : {}),
      ...(typeof event.savedChars === "number"
        ? { savedChars: event.savedChars }
        : {}),
    };
    const activity = [...(run.activity || [])];
    const previous = activity.at(-1);
    if (
      previous?.stage === progress.stage &&
      previous?.message === progress.message
    )
      activity[activity.length - 1] = progress;
    else activity.push(progress);
    return { ...run, progress, activity: activity.slice(-24) };
  }
  if (event.type === "usage") {
    const counts = tokenCounts(event.usage);
    if (counts)
      return {
        ...run,
        usage: { ...counts, source: "app-server", scope: "run", updatedAt: at },
      };
  }
  if (event.type === "turn" && typeof event.turnId === "string")
    return { ...run, turnId: event.turnId };
  return run;
}

const fields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
] as const;
export function tokenCounts(value: unknown): TokenCounts | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (
    !fields.every(
      (key) => Number.isSafeInteger(v[key]) && (v[key] as number) >= 0,
    )
  )
    return;
  if (
    v.totalTokens !== (v.inputTokens as number) + (v.outputTokens as number) ||
    (v.cachedInputTokens as number) > (v.inputTokens as number) ||
    (v.reasoningOutputTokens as number) > (v.outputTokens as number)
  )
    return;
  return Object.fromEntries(
    fields.map((key) => [key, v[key]]),
  ) as unknown as TokenCounts;
}
const zero: TokenCounts = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

// Native totals are cumulative across a thread, including restored turns.
// Never sum snapshots or silently treat a missing resumed baseline as zero.
export class UsageTracker {
  private baseline?: TokenCounts;
  private accepting = false;
  private turnId?: string;
  private last?: TokenCounts;
  threadId?: string;
  constructor(
    resumed: boolean,
    private emit: (event: AgentEvent) => void,
  ) {
    if (!resumed) this.baseline = { ...zero };
  }
  restore(value: unknown) {
    if (!this.accepting) this.baseline = tokenCounts(value) || this.baseline;
  }
  hasBaseline() {
    return Boolean(this.baseline);
  }
  begin() {
    this.accepting = true;
  }
  turn(id: string) {
    this.turnId = id;
  }
  notification(p: any) {
    if (this.threadId && p.threadId !== this.threadId) return;
    const total = tokenCounts(p.tokenUsage?.total);
    if (!total) return;
    if (!this.accepting) {
      this.baseline = total;
      return;
    }
    if (!this.turnId || p.turnId !== this.turnId || !this.baseline) return;
    const delta = Object.fromEntries(
      fields.map((key) => [key, total[key] - this.baseline![key]]),
    ) as unknown as TokenCounts;
    if (fields.some((key) => delta[key] < 0)) return;
    if (this.last && fields.every((key) => this.last![key] === delta[key]))
      return;
    this.last = delta;
    this.emit({
      type: "usage",
      usage: { ...delta, source: "app-server", scope: "run" },
    });
  }
}
