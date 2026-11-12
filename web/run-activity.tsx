import { useEffect, useState } from "react";
import type { Run } from "../src/types.js";

const number = (n: number) => n.toLocaleString("en-US");
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function RunUsage({ run }: { run: Run }) {
  const u = run.usage;
  return u ? (
    <div className="run-usage" aria-label="本次 token 用量">
      <span>
        <strong className="mono">{number(u.totalTokens)}</strong> token
      </span>
      <span>
        输入 <b className="mono">{number(u.inputTokens)}</b>
        <small>其中缓存 {number(u.cachedInputTokens)}</small>
      </span>
      <span>
        输出 <b className="mono">{number(u.outputTokens)}</b>
        <small>其中推理 {number(u.reasoningOutputTokens)}</small>
      </span>
    </div>
  ) : (
    <p className="usage-unavailable">
      {run.state === "running" || run.state === "awaiting_approval"
        ? "Token 用量等待后端返回"
        : "本次未记录 token 用量"}
    </p>
  );
}
export function RunActivity({
  run,
  connected,
  onCancel,
}: {
  run: Run;
  connected: boolean;
  onCancel: () => void;
}) {
  const [clock, setClock] = useState(Date.now());
  const active = run.state === "running" || run.state === "awaiting_approval";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.id, active]);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : clock;
  const states = {
    succeeded: "已完成",
    failed: "失败",
    interrupted: "已中断",
    awaiting_approval: "等待执行审批",
    running: "分析中",
  };
  const stages = {
    starting: "准备调查",
    investigating: "调查源码",
    thinking: "分析证据",
    generating: run.kind === "analysis" ? "生成讲解" : "生成回答",
    validating: "校验结果",
  };
  const stage =
    active && run.state !== "awaiting_approval" && run.progress
      ? stages[run.progress.stage]
      : states[run.state];
  const commentary = run.activity?.filter((a) => a.source === "agent").at(-1);
  const lastAt = [run.progress?.at, run.usage?.updatedAt]
    .filter(Boolean)
    .sort()
    .at(-1);
  return (
    <section
      className="run-panel"
      aria-label={run.kind === "analysis" ? "本次分析" : "本次追问"}
    >
      <div className="run-heading">
        <span className={active ? "pulse-dot" : "run-complete-dot"} />
        <strong>
          {run.kind === "analysis" ? "本次分析" : "本次追问"} · {stage}
        </strong>
        <span className="run-elapsed mono">
          耗时{" "}
          {active || run.finishedAt
            ? duration(end - Date.parse(run.createdAt))
            : "未记录"}
        </span>
        {active ? (
          <button className="quiet" onClick={onCancel}>
            停止
          </button>
        ) : null}
      </div>
      <div className="run-model mono">
        {run.backend} · {run.model || "backend default"}
        {run.effort ? ` · ${run.effort}` : ""}
      </div>
      {active && run.progress ? (
        <p className="run-current" role="status">
          {run.progress.message}
        </p>
      ) : null}
      {active && commentary && commentary.message !== run.progress?.message ? (
        <p className="run-commentary">{commentary.message}</p>
      ) : null}
      {active ? (
        <div className="run-observed">
          <span>{connected ? "进度已连接" : "进度连接中，正在恢复事件"}</span>
          {lastAt ? (
            <span>最近活动 {duration(clock - Date.parse(lastAt))} 前</span>
          ) : null}
          {run.progress?.filesRead !== undefined ? (
            <span>已读取 {run.progress.filesRead} 份源码</span>
          ) : null}
          {run.progress?.toolCalls !== undefined ? (
            <span>{run.progress.toolCalls} 次调查操作</span>
          ) : null}
          {run.progress?.stage === "generating" && run.progress.outputChars ? (
            <span>已生成 {number(run.progress.outputChars)} 字符</span>
          ) : null}
        </div>
      ) : null}
      <RunUsage run={run} />
      <details className="run-details">
        <summary>任务详情与进度记录</summary>
        <p className="usage-note">
          {run.state === "succeeded"
            ? "本次后端报告用量"
            : "截至最近一次后端报告，可能尚未完整"}
          。缓存包含在输入中，推理包含在输出中；同一任务的多轮模型请求累计计数。
        </p>
        {run.usage ? (
          <p className="usage-note">
            用量更新时间：{new Date(run.usage.updatedAt).toLocaleString()}
          </p>
        ) : null}
        <ol className="run-timeline">
          {run.activity?.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <time className="mono">
                {new Date(a.at).toLocaleTimeString([], { hour12: false })}
              </time>
              <span>{a.message}</span>
            </li>
          ))}
        </ol>
        <span className="mono subtle run-id">{run.id}</span>
      </details>
    </section>
  );
}
