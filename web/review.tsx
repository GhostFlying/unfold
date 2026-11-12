import { useEffect, useRef, useState } from "react";
import type {
  Approval,
  Draft,
  Explanation,
  FileDiff,
  Reference,
  Review,
  Run,
  Snapshot,
  Source,
} from "../src/types.js";
import { diffLines } from "../src/diff.js";
import { frameHtml } from "../src/html.js";
import { ReviewAgentSettings } from "./agent-settings.js";
import { api, nav } from "./api.js";
import { RunActivity, RunUsage } from "./run-activity.js";
import { applyRunEvent } from "../src/telemetry.js";
import { ChangeGuideView } from "./change-guide.js";

type Bundle = {
  review: Review;
  version: Snapshot;
  latestVersionId: string;
  explanation?: Omit<Explanation, "threadId">;
  stale: boolean;
  comments: any[];
};
export function ReviewPage({
  id,
  explanationId,
  owner,
  onChange,
}: {
  id: string;
  explanationId?: string;
  owner: boolean;
  onChange: () => Promise<void>;
}) {
  const [bundle, setBundle] = useState<Bundle>(),
    [runs, setRuns] = useState<Run[]>([]),
    [drafts, setDrafts] = useState<Draft[]>([]),
    [approvals, setApprovals] = useState<Approval[]>([]),
    [history, setHistory] = useState<Explanation[]>([]),
    [tab, setTab] = useState("explanation"),
    [panel, setPanel] = useState(""),
    [selected, setSelected] = useState<Reference>(),
    [source, setSource] = useState<Source>(),
    [quote, setQuote] = useState(""),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [streamConnected, setStreamConnected] = useState(false),
    [preview, setPreview] = useState<any>(),
    [general, setGeneral] = useState(false),
    [diffSnapshot, setDiffSnapshot] = useState<Snapshot>();
  const [agentSettings, setAgentSettings] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null),
    [height, setHeight] = useState(700);
  const reload = async () => {
    const publicData = [
      api<Bundle>(
        `/reviews/${id}${explanationId ? `?explanationId=${explanationId}` : ""}`,
      ),
      api<Explanation[]>(`/reviews/${id}/history`),
    ];
    const [b, h] = await Promise.all(publicData);
    setBundle(b as Bundle);
    setHistory(h as Explanation[]);
    if (owner) {
      const [r, d, a] = await Promise.all([
        api<Run[]>(`/reviews/${id}/runs`),
        api<Draft[]>(`/reviews/${id}/drafts`),
        api<Approval[]>("/approvals"),
      ]);
      setRuns(r);
      setDrafts(d);
      setApprovals(a.filter((a) => a.reviewId === id));
    }
  };
  const action = async (fn: () => Promise<unknown>) => {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    reload().catch((e) => setError(e.message));
  }, [id, explanationId, owner]);
  const active = runs.find(
    (r) => r.state === "running" || r.state === "awaiting_approval",
  );
  useEffect(() => {
    if (!active || !owner) return;
    setStreamConnected(false);
    const events = new EventSource(
      `/api/v1/runs/${active.id}/events?after=${active.eventSeq || 0}`,
    );
    events.onopen = () => setStreamConnected(true);
    events.onmessage = (e) => {
      const event = JSON.parse(e.data);
      setRuns((current) =>
        current.map((run) =>
          run.id === active.id ? applyRunEvent(run, event) : run,
        ),
      );
      if (event.type === "finished" || event.type === "approval") {
        void reload();
        if (event.type === "finished") events.close();
      }
    };
    events.onerror = () => {
      setStreamConnected(false);
      // EventSource reconnects with Last-Event-ID. Reload also catches a terminal
      // run if its final event was lost while this tab was disconnected.
      void reload().catch(() => {});
    };
    return () => events.close();
  }, [active?.id, owner]);
  const openReference = async (ref: Reference) => {
    setSelected(ref);
    setQuote("");
    setGeneral(false);
    setPanel("source");
    setSource(
      await api(
        `/reviews/${id}/source?${new URLSearchParams({ versionId: ref.versionId || bundle?.explanation?.versionId || bundle!.version.id, path: ref.path, side: ref.side })}`,
      ),
    );
  };
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (
        e.source !== iframe.current?.contentWindow ||
        !e.data ||
        typeof e.data !== "object"
      )
        return;
      if (e.data.type === "unfold:height" && Number.isFinite(e.data.height))
        setHeight(Math.max(360, Math.min(16000, e.data.height)));
      else if (
        e.data.type === "unfold:context" &&
        typeof e.data.referenceId === "string"
      ) {
        const ref = bundle?.explanation?.references.find(
          (r) => r.id === e.data.referenceId,
        );
        if (ref) void action(() => openReference(ref));
      } else if (
        e.data.type === "unfold:quote" &&
        typeof e.data.text === "string" &&
        owner
      ) {
        setQuote(e.data.text.slice(0, 4000));
        setSelected(undefined);
        setPanel("ask");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [bundle, owner, diffSnapshot]);
  if (!bundle)
    return (
      <main className="reader loading">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <p className="subtle">正在读取改动…</p>
        )}
      </main>
    );
  const { review, version, explanation } = bundle,
    shown = diffSnapshot || version;
  const displayedRun =
    active ||
    runs.find(
      (r) => r.kind === "analysis" && r.explanationId === explanation?.id,
    ) ||
    runs[0];
  const contextBody = () =>
    quote
      ? `${body}\n\n选中上下文：\n${quote
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`
      : body;
  const selectLine = async (
    file: FileDiff,
    line: number,
    side: "old" | "new",
    snapshot = shown,
  ) => {
    if (owner) {
      const ref = await api<Reference>(`/reviews/${id}/references`, "POST", {
        versionId: snapshot.id,
        path: side === "old" ? file.oldPath : file.path,
        side,
        start: line,
        end: line,
      });
      await openReference(ref);
    } else {
      const s = await api<Source>(
        `/reviews/${id}/source?${new URLSearchParams({ versionId: snapshot.id, path: side === "old" ? file.oldPath : file.path, side })}`,
      );
      setSource(s);
      setSelected(undefined);
      setPanel("source");
    }
  };
  return (
    <>
      <div className={`review-layout ${panel ? "has-panel" : ""}`}>
        <main className="reader">
          <div className="review-breadcrumb mono">
            <button className="quiet" onClick={() => nav("/")}>
              ← unfold
            </button>
            <span>/</span>
            <a href={review.target.url} target="_blank" rel="noreferrer">
              {review.target.repo}{" "}
              <span className="subtle">#{review.target.number} ↗</span>
            </a>
          </div>
          <header className="review-heading">
            <h1>{review.title}</h1>
            <div className="review-actions">
              {owner ? (
                <>
                  <button
                    disabled={busy || !!active}
                    className="primary"
                    onClick={() =>
                      action(async () => {
                        await api(`/reviews/${id}/analyze`, "POST", {});
                        await reload();
                      })
                    }
                  >
                    {active ? "分析中…" : explanation ? "重新讲解" : "生成讲解"}{" "}
                    <span>✳</span>
                  </button>
                  <button
                    className="quiet"
                    title="手动刷新 MR"
                    disabled={busy}
                    onClick={() =>
                      action(async () => {
                        await api(`/reviews/${id}/refresh`, "POST", {});
                        await reload();
                        await onChange();
                        setNotice("已刷新原 MR 的提交与讨论");
                      })
                    }
                  >
                    刷新 ↻
                  </button>
                </>
              ) : null}
              <button
                className="quiet"
                onClick={() =>
                  action(async () => {
                    const { url } = await api(
                      `/reviews/${id}/share${explanationId ? `?explanationId=${explanationId}` : ""}`,
                    );
                    await navigator.clipboard.writeText(url);
                    setNotice("已复制公司内网只读链接");
                  })
                }
              >
                分享 ↗
              </button>
            </div>
          </header>
          <div className="review-meta">
            <span className="mono">
              {version.base.slice(0, 8)} <span className="subtle">←</span>{" "}
              {version.head.slice(0, 8)}
            </span>
            <span>{version.files.length} 个文件</span>
            <span className="add">
              +{version.files.reduce((s, f) => s + f.added, 0)}
            </span>
            <span className="del">
              −{version.files.reduce((s, f) => s + f.deleted, 0)}
            </span>
            {owner ? (
              <button
                className="quiet"
                onClick={() => setAgentSettings(true)}
                aria-label="当前 MR 的 Agent 设置"
              >
                {review.backend} · Agent 设置
              </button>
            ) : null}
            {explanation ? (
              <span className="subtle">
                讲解 · {explanation.backend} ·{" "}
                {new Date(explanation.createdAt).toLocaleString()}
              </span>
            ) : null}
          </div>
          <nav className="reader-tabs" aria-label="改动内容">
            {[
              ["guide", "改动导览"],
              ["explanation", "讲解"],
              ["changes", "Diff"],
              ["discussion", `原 MR 讨论 · ${bundle.comments.length}`],
              ["history", `历史 · ${history.length}`],
            ].map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
            {owner ? (
              <div className="reader-tools">
                <button
                  className={panel === "ask" ? "active" : ""}
                  onClick={() => setPanel(panel === "ask" ? "" : "ask")}
                >
                  问 Agent ↗
                </button>
                <button
                  className={panel === "drafts" ? "active" : ""}
                  onClick={() => setPanel(panel === "drafts" ? "" : "drafts")}
                >
                  草稿
                  {drafts.filter((d) => d.state === "draft").length
                    ? ` · ${drafts.filter((d) => d.state === "draft").length}`
                    : ""}
                </button>
                <button
                  className={panel === "approvals" ? "active" : ""}
                  onClick={() =>
                    setPanel(panel === "approvals" ? "" : "approvals")
                  }
                >
                  审批{approvals.some((a) => a.state === "pending") ? " ●" : ""}
                </button>
              </div>
            ) : null}
          </nav>
          {error ? (
            <div className="inline-alert error" role="alert">
              {error}
              <button className="quiet" onClick={() => setError("")}>
                ×
              </button>
            </div>
          ) : null}
          {notice ? (
            <div className="inline-alert notice" role="status">
              {notice}
            </div>
          ) : null}
          {bundle.stale ? (
            <div className="stale-note">
              原 MR 已有新提交。这份讲解仍对应{" "}
              <code>{version.head.slice(0, 8)}</code>。
              <button
                className="quiet"
                onClick={() =>
                  action(async () => {
                    setDiffSnapshot(await api(`/reviews/${id}/snapshot`));
                    setTab("changes");
                  })
                }
              >
                查看最新 Diff →
              </button>
            </div>
          ) : null}
          {owner &&
          displayedRun &&
          (active || displayedRun.progress || displayedRun.usage) ? (
            <RunActivity
              run={displayedRun}
              connected={streamConnected}
              onCancel={() =>
                action(async () => {
                  await api(`/runs/${active!.id}/cancel`, "POST", {});
                  await reload();
                })
              }
            />
          ) : null}
          {!active && runs[0]?.state === "failed" ? (
            <div className="inline-alert error">
              本次调查失败：{runs[0].error}。已有讲解仍然保留。
            </div>
          ) : null}
          {tab === "guide" ? (
            <ChangeGuideView
              key={explanation?.id || id}
              explanation={explanation}
              version={version}
              onReference={(ref) => {
                void action(() => openReference(ref));
              }}
              renderDiff={(file) => (
                <File
                  key={file.path}
                  file={file}
                  onLine={(line, side) => {
                    void action(() => selectLine(file, line, side, version));
                  }}
                />
              )}
            />
          ) : null}
          {tab === "explanation" ? (
            explanation ? (
              <section className="explanation-section">
                <div className="explanation-label mono">
                  <span>// understanding the change</span>
                  <a
                    href={`/api/v1/reviews/${id}/export${explanationId ? `?explanationId=${explanationId}` : ""}`}
                    download
                  >
                    导出 HTML ↓
                  </a>
                </div>
                <iframe
                  ref={iframe}
                  className="explanation-frame"
                  title="交互式改动讲解"
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  srcDoc={frameHtml(explanation.html)}
                  style={{ height }}
                />
                <div className="evidence-index">
                  <span className="mono subtle">// source references</span>
                  {explanation.references.map((ref) => (
                    <button
                      key={ref.id}
                      className="reference-link mono"
                      onClick={() => action(() => openReference(ref))}
                    >
                      {ref.path}:{ref.start} <span>↗</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : (
              <section className="no-explanation">
                <span className="mono subtle">// start with the source</span>
                <h2>
                  Diff 已就绪。
                  <br />
                  接下来，理解它为什么这样改。
                </h2>
                <p className="muted">
                  {owner
                    ? "点击「生成讲解」，Agent 会读取真实源码，整理设计与行为变化。"
                    : "这份改动还没有已发布的讲解。你可以先阅读 Diff。"}
                </p>
                <button
                  className="text-button"
                  onClick={() => setTab("changes")}
                >
                  先看 {version.files.length} 个文件的改动 →
                </button>
                <details className="description">
                  <summary>MR 描述</summary>
                  <pre>{version.description || "暂无描述"}</pre>
                </details>
              </section>
            )
          ) : null}
          {tab === "changes" ? (
            <section className="diff-section">
              <div className="section-heading">
                <span className="mono subtle">// {shown.head.slice(0, 8)}</span>
                <span className="hint">
                  点击行号查看源码{owner ? "，或创建评论草稿" : ""}
                </span>
              </div>
              {shown.files.map((file) => (
                <File
                  key={file.path}
                  file={file}
                  onLine={(line, side) =>
                    action(() => selectLine(file, line, side))
                  }
                />
              ))}
            </section>
          ) : null}
          {tab === "discussion" ? (
            <section className="discussion-section">
              <p className="hint">
                原 MR 是已发布讨论的权威来源。
                {owner ? "点击刷新，获取作者后续回复。" : ""}
              </p>
              {bundle.comments.length ? (
                bundle.comments.map((c) => (
                  <article className="discussion" key={c.id}>
                    <header>
                      <span>{c.author || "Reviewer"}</span>
                      {c.path ? (
                        <code>
                          {c.path}:{c.line}
                        </code>
                      ) : null}
                      {c.outdated ? (
                        <span className="hint">旧版本讨论</span>
                      ) : null}
                    </header>
                    <p>{c.body}</p>
                  </article>
                ))
              ) : (
                <p className="muted">暂无已发布讨论。</p>
              )}
            </section>
          ) : null}
          {tab === "history" ? (
            <section className="history-section">
              <p className="hint">
                每份成功讲解独立保留，固定入口默认展示最近成功的一份。
              </p>
              {history.map((e) => (
                <a
                  className="history-row"
                  key={e.id}
                  href={`/r/${id}/v/${e.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    nav(`/r/${id}/v/${e.id}`);
                  }}
                >
                  <div>
                    <strong>{e.title}</strong>
                    <p className="hint">
                      {new Date(e.createdAt).toLocaleString()} · {e.backend} ·{" "}
                      {e.model}
                      {e.effort ? ` · ${e.effort}` : ""}
                    </p>
                  </div>
                  <span className="mono">{e.versionId.slice(0, 8)} ↗</span>
                </a>
              ))}
            </section>
          ) : null}
          <footer className="reader-footer mono">
            unfold · {owner ? "private workspace" : "read-only view"}
            <span>fixed revision · human review</span>
          </footer>
        </main>
        {panel ? (
          <aside className="inspector">
            <header>
              <div className="inspector-tabs">
                {(owner
                  ? ["ask", "source", "drafts", "approvals"]
                  : ["source"]
                ).map((t) => (
                  <button
                    className={panel === t ? "active" : ""}
                    key={t}
                    onClick={() => setPanel(t)}
                  >
                    {
                      (
                        {
                          ask: "追问",
                          source: "源码",
                          drafts: "草稿",
                          approvals: "审批",
                        } as any
                      )[t]
                    }
                  </button>
                ))}
              </div>
              <button
                className="quiet close-panel"
                onClick={() => setPanel("")}
                aria-label="关闭侧栏"
              >
                ×
              </button>
            </header>
            {selected ? (
              <div className="context-selection">
                <code>
                  {selected.path}:{selected.start}
                </code>
                <button
                  className="quiet"
                  aria-label="清除代码上下文"
                  onClick={() => setSelected(undefined)}
                >
                  ×
                </button>
                <small>
                  {selected.commit.slice(0, 8)} · {selected.side}
                </small>
              </div>
            ) : null}
            {quote ? (
              <div className="quote-selection">
                <blockquote>{quote}</blockquote>
                <button className="quiet" onClick={() => setQuote("")}>
                  清除选中段落
                </button>
              </div>
            ) : null}
            {panel === "source" ? (
              <>
                <div className="source-body">
                  {source ? (
                    <>
                      <div className="source-caption mono">
                        {source.path}
                        <br />
                        <span className="subtle">
                          {source.commit.slice(0, 12)} · {source.side}
                        </span>
                      </div>
                      <pre>
                        {source.content.split("\n").map((line, i) => (
                          <div
                            key={i}
                            className={
                              selected &&
                              i + 1 >= selected.start &&
                              i + 1 <= selected.end
                                ? "selected-source-line"
                                : ""
                            }
                          >
                            <span className="line-number">{i + 1}</span>
                            {line || " "}
                          </div>
                        ))}
                      </pre>
                    </>
                  ) : (
                    <p className="muted">
                      点击讲解中的代码引用，查看对应版本的源码。
                    </p>
                  )}
                </div>
                {owner ? (
                  <div className="inspector-footer">
                    <button className="quiet" onClick={() => setPanel("ask")}>
                      针对这里追问 ↗
                    </button>
                    <button
                      className="quiet"
                      onClick={() => setPanel("drafts")}
                    >
                      创建草稿 ↗
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
            {panel === "ask" && owner ? (
              <>
                <div className="conversation">
                  {runs
                    .filter((r) => r.kind === "question")
                    .slice()
                    .reverse()
                    .map((r) => (
                      <article className="message" key={r.id}>
                        <div className="question-text">{r.question}</div>
                        <RunUsage run={r} />
                        <div className="answer-text">
                          {r.answer || r.error || "正在调查…"}
                        </div>
                        <span className="hint mono">
                          {r.backend} · {r.model || "解析模型中"}
                          {r.effort ? ` · ${r.effort}` : ""} · {r.state}
                        </span>
                      </article>
                    ))}
                  {!runs.some((r) => r.kind === "question") ? (
                    <div className="conversation-empty">
                      <span className="mono accent">?</span>
                      <h3>从一个问题开始。</h3>
                      <p>追问整个改动，或选择代码与讲解中的一段内容。</p>
                      <small>对话仅你可见，不会发到原 MR。</small>
                    </div>
                  ) : null}
                </div>
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await api(`/reviews/${id}/questions`, "POST", {
                        question: contextBody(),
                        referenceId: selected?.id,
                        explanationId: explanation?.id,
                      });
                      setBody("");
                      await reload();
                    });
                  }}
                >
                  <textarea
                    aria-label="追问内容"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="这次改动为什么…"
                    required
                  />
                  <div>
                    <span className="hint">私有追问</span>
                    <button className="primary" disabled={busy || !!active}>
                      发送 ↑
                    </button>
                  </div>
                </form>
              </>
            ) : null}
            {panel === "drafts" && owner ? (
              <div className="draft-panel">
                <p className="hint">先形成意见。预览并确认后，才写回原 MR。</p>
                <form
                  className="draft-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action(async () => {
                      await api(`/reviews/${id}/drafts`, "POST", {
                        body: contextBody(),
                        referenceId: general ? undefined : selected?.id,
                        versionId: version.id,
                      });
                      setBody("");
                      setQuote("");
                      await reload();
                    });
                  }}
                >
                  <textarea
                    aria-label="评论草稿"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    placeholder="问题、代码背景和建议…"
                    required
                  />
                  {selected ? (
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={general}
                        onChange={(e) => setGeneral(e.target.checked)}
                      />
                      改为普通评论
                    </label>
                  ) : (
                    <p className="hint">
                      普通评论 · 可先在 Diff 中选一行，创建行内评论。
                    </p>
                  )}
                  <button className="primary" disabled={busy}>
                    保存草稿
                  </button>
                </form>
                <div className="draft-list">
                  {drafts.map((d) => (
                    <DraftEditor
                      key={`${d.id}-${d.revision}`}
                      draft={d}
                      busy={busy}
                      onSave={(body, general) =>
                        action(async () => {
                          await api(`/drafts/${d.id}`, "PATCH", {
                            body,
                            revision: d.revision,
                            general,
                          });
                          await reload();
                        })
                      }
                      onPreview={() =>
                        action(async () =>
                          setPreview(
                            await api(`/drafts/${d.id}/preview`, "POST", {}),
                          ),
                        )
                      }
                      onReconcile={() =>
                        action(async () => {
                          await api(`/drafts/${d.id}/reconcile`, "POST", {});
                          await reload();
                        })
                      }
                    />
                  ))}
                </div>
              </div>
            ) : null}
            {panel === "approvals" && owner ? (
              <div className="approval-panel">
                <p className="hint">
                  未批准前不会执行项目代码。每次授权只覆盖下面的具体操作。
                </p>
                {approvals.length ? (
                  approvals.map((a) => (
                    <article key={a.id} className="approval">
                      <div className="section-heading">
                        <strong>{a.request.purpose}</strong>
                        <span className="hint">{a.state}</span>
                      </div>
                      <pre>{a.request.command}</pre>
                      <dl>
                        <dt>目录</dt>
                        <dd>{a.request.cwd}</dd>
                        <dt>版本</dt>
                        <dd className="mono">{a.versionId.slice(0, 12)}</dd>
                        <dt>网络</dt>
                        <dd>{a.request.network ? "申请联网" : "禁网"}</dd>
                        <dt>副作用</dt>
                        <dd>{a.request.sideEffects}</dd>
                      </dl>
                      {a.state === "pending" ? (
                        <div className="approval-actions">
                          <button
                            onClick={() =>
                              action(async () => {
                                await api(
                                  `/approvals/${a.id}/decision`,
                                  "POST",
                                  { confirm: a.digest, approve: false },
                                );
                                await reload();
                              })
                            }
                          >
                            拒绝
                          </button>
                          <button
                            className="primary"
                            onClick={() =>
                              action(async () => {
                                await api(
                                  `/approvals/${a.id}/decision`,
                                  "POST",
                                  { confirm: a.digest, approve: true },
                                );
                                await reload();
                              })
                            }
                          >
                            仅批准这次操作
                          </button>
                        </div>
                      ) : null}
                      {a.receipt ? (
                        <pre>
                          exit: {String(a.receipt.exitCode)}
                          {a.receipt.timedOut ? " · timed out" : ""}
                          {"\n"}
                          {a.receipt.stdout}
                          {a.receipt.stderr}
                        </pre>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <p className="muted">没有待处理的执行请求。</p>
                )}
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
      {preview ? (
        <div className="modal-backdrop">
          <section
            className="modal preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-title"
          >
            <header>
              <h2 id="preview-title">确认发布到原 MR</h2>
              <button
                className="quiet"
                aria-label="关闭预览"
                onClick={() => setPreview(undefined)}
              >
                ×
              </button>
            </header>
            <p className="hint">
              {preview.kind === "inline" ? "原生行内评论" : "普通 MR 评论"} ·{" "}
              {review.target.repo} #{review.target.number}
            </p>
            {preview.warning ? (
              <p className="stale-note">{preview.warning}</p>
            ) : null}
            <pre className="comment-preview">{preview.body}</pre>
            <footer>
              <button onClick={() => setPreview(undefined)}>继续编辑</button>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    const result = await api(
                      `/drafts/${preview.draftId}/publish`,
                      "POST",
                      { confirm: preview.digest },
                    );
                    setPreview(undefined);
                    await reload();
                    setNotice(
                      result.state === "published"
                        ? "评论已发布。刷新原 MR 可查看后续回复。"
                        : "结果未知，草稿已保留。请回查结果，不要重复发布。",
                    );
                  })
                }
              >
                确认发布
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {owner && agentSettings ? (
        <ReviewAgentSettings
          reviewId={id}
          onClose={() => setAgentSettings(false)}
          onSave={reload}
        />
      ) : null}
    </>
  );
}

function File({
  file,
  onLine,
}: {
  file: FileDiff;
  onLine: (line: number, side: "old" | "new") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article className="file-diff">
      <button
        className="file-heading"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="subtle">{open ? "⌄" : "›"}</span>
        <span className="file-path mono">{file.path}</span>
        {file.oldPath !== file.path ? (
          <span className="hint">← {file.oldPath}</span>
        ) : null}
        <span className="file-stats mono">
          <span className="add">+{file.added}</span>{" "}
          <span className="del">−{file.deleted}</span>
        </span>
      </button>
      {open ? (
        file.binary ? (
          <p className="hint file-warning">二进制文件 · 不提供行内定位。</p>
        ) : (
          <>
            {file.truncated ? (
              <p className="file-warning">
                Diff 不完整，此文件禁止行内评论定位。
              </p>
            ) : null}
            <div className="diff-code">
              {diffLines(file.patch).map((line, i) => (
                <div key={i} className={`diff-line ${line.kind}`}>
                  <button
                    className="line-number"
                    tabIndex={line.old === undefined ? -1 : 0}
                    disabled={line.old === undefined}
                    onClick={() =>
                      line.old !== undefined && onLine(line.old, "old")
                    }
                    aria-label={`旧版第 ${line.old} 行`}
                  >
                    {line.old}
                  </button>
                  <button
                    className="line-number"
                    tabIndex={line.new === undefined ? -1 : 0}
                    disabled={line.new === undefined}
                    onClick={() =>
                      line.new !== undefined && onLine(line.new, "new")
                    }
                    aria-label={`新版第 ${line.new} 行`}
                  >
                    {line.new}
                  </button>
                  <span className="diff-marker">
                    {line.kind === "add"
                      ? "+"
                      : line.kind === "delete"
                        ? "−"
                        : " "}
                  </span>
                  <code>{line.text || " "}</code>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}
    </article>
  );
}
function DraftEditor({
  draft: d,
  busy,
  onSave,
  onPreview,
  onReconcile,
}: {
  draft: Draft;
  busy: boolean;
  onSave: (body: string, general: boolean) => void;
  onPreview: () => void;
  onReconcile: () => void;
}) {
  const [text, setText] = useState(d.body),
    [general, setGeneral] = useState(false);
  return (
    <article className="draft-entry">
      <div className="draft-entry-meta">
        <span>
          {d.anchor ? `${d.anchor.path}:${d.anchor.start}` : "普通评论"}
        </span>
        <span className="hint">{d.state}</span>
      </div>
      {d.state === "draft" ? (
        <>
          <textarea
            aria-label={`编辑草稿 ${d.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={general}
              onChange={(e) => setGeneral(e.target.checked)}
            />
            重新定位为当前版本的普通评论
          </label>
          <div className="draft-entry-actions">
            <button
              className="quiet"
              disabled={busy || !text.trim()}
              onClick={() => onSave(text, general)}
            >
              保存修改
            </button>
            <button
              className="text-button"
              disabled={busy || text !== d.body || general}
              onClick={onPreview}
            >
              预览发布 →
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{d.body}</p>
          {d.remoteId ? (
            <p className="hint mono">remote comment · {d.remoteId}</p>
          ) : null}
          {d.error ? <p className="error">{d.error}</p> : null}
          {d.state === "unknown" ? (
            <button onClick={onReconcile}>回查结果</button>
          ) : null}
        </>
      )}
    </article>
  );
}
