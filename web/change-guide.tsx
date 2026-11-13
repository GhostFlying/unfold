import { useState, type ReactNode } from "react";
import type {
  Explanation,
  FileDiff,
  Reference,
  Snapshot,
} from "../src/types.js";
import {
  projectGuide,
  scopePath,
  type ReviewScope,
} from "../src/review-scope.js";

export function ChangeGuideView({
  explanation,
  version,
  onReference,
  renderDiff,
  scope = {},
  onScopeChange,
  onRefreshOwnership,
  onOpenFull,
}: {
  explanation?: Omit<Explanation, "threadId">;
  version: Snapshot;
  onReference: (ref: Reference) => void;
  renderDiff: (file: FileDiff) => ReactNode;
  scope?: ReviewScope;
  onScopeChange?: (scope: ReviewScope) => void;
  onRefreshOwnership?: () => void;
  onOpenFull?: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [pathDraft, setPathDraft] = useState(scope.path || "");
  const [customPath, setCustomPath] = useState(false);
  const [pathError, setPathError] = useState("");
  if (!explanation?.guide?.groups.length)
    return (
      <section className="guide-empty">
        <span className="mono subtle">// logical change guide</span>
        <h2>这份讲解还没有阅读导览。</h2>
        <p>
          新生成的讲解会按修改目的分组，并逐项说明修改前后、原因与源码证据。已有讲解和
          Diff 仍可阅读。
        </p>
        {explanation && onOpenFull ? (
          <button className="text-button" onClick={onOpenFull}>
            打开完整讲解 ↗
          </button>
        ) : null}
      </section>
    );
  let view: ReturnType<typeof projectGuide>;
  try {
    view = projectGuide(explanation, version, scope);
  } catch (e: any) {
    return (
      <section className="guide-empty">
        <p role="alert">{e.message}</p>
        <button onClick={() => onScopeChange?.({})}>查看全部改动</button>
      </section>
    );
  }
  const groups = view.groups;
  const directIds = new Set(groups.flatMap((g) => g.points.map((p) => p.id)));
  const contextGroups = view.contextGroups.map((c) => ({
    ...c,
    group: {
      ...c.group,
      points: c.group.points.filter((p) => !directIds.has(p.id)),
    },
  }));
  const visibleGroups = [...groups, ...contextGroups.map((c) => c.group)];
  const points = visibleGroups.flatMap((g) => g.points);
  const group = visibleGroups.find((g) =>
    g.points.some((p) => p.id === selected),
  );
  const point = points.find((p) => p.id === selected);
  const contextEntry = contextGroups.find((c) =>
    c.group.points.some((p) => p.id === selected),
  );
  const scoped = !!(scope.owner || scope.path);
  const choose = (next: ReviewScope) => {
    setSelected(undefined);
    setPathError("");
    setCustomPath(false);
    onScopeChange?.(next);
  };
  const index = point ? points.indexOf(point) : -1;
  const refs = explanation!.references.filter((r) =>
    point?.referenceIds.includes(r.id),
  );
  const files = version.files.filter(
    (f) => point?.files.includes(f.path) || point?.files.includes(f.oldPath),
  );
  return (
    <section className="change-guide" aria-label="阅读导览">
      <div className="guide-scope">
        <div className="scope-paths" role="group" aria-label="阅读范围">
          <span className="scope-label">阅读范围</span>
          <button
            className="scope-chip"
            aria-pressed={!scoped}
            onClick={() => choose({})}
          >
            全部改动
          </button>
          {view.paths.map((option) => (
            <button
              key={option.path}
              className="scope-chip mono"
              aria-pressed={view.scope.path === option.path}
              title={`${option.label} · ${option.fileCount} 个文件`}
              onClick={() => choose({ path: option.path })}
            >
              {option.label}
            </button>
          ))}
          {scope.path &&
          !view.paths.some((option) => option.path === view.scope.path) ? (
            <button
              className="scope-chip mono"
              aria-pressed="true"
              onClick={() => {
                setPathDraft(scope.path!);
                setCustomPath(true);
              }}
            >
              {view.scope.path}
            </button>
          ) : null}
          {scope.owner ? (
            <button
              className="scope-chip"
              aria-pressed="true"
              onClick={() => choose(scope)}
            >
              原链接范围
            </button>
          ) : null}
          <button
            className="scope-custom"
            aria-expanded={customPath}
            onClick={() => {
              setPathDraft(scope.path || "");
              setCustomPath(!customPath);
            }}
          >
            自定义路径…
          </button>
        </div>
        {customPath ? (
          <form
            className="scope-custom-form"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                choose({ path: scopePath(pathDraft.trim()) });
              } catch {
                setPathError(
                  "请输入仓库内的文件或目录路径，例如 src/runtime/。",
                );
              }
            }}
          >
            <input
              aria-label="审查路径"
              placeholder="输入文件或目录路径"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              autoFocus
            />
            <button className="quiet">应用路径</button>
            {pathError ? <span role="alert">{pathError}</span> : null}
          </form>
        ) : null}
        <div className="scope-status">
          <span className="hint">
            {scoped
              ? `${groups.reduce((n, g) => n + g.points.length, 0)} 个相关修改点 · ${contextGroups.length} 个背景模块`
              : "同一份讲解 · 按职责组织"}
          </span>
          {onRefreshOwnership ? (
            <button className="quiet" onClick={onRefreshOwnership}>
              刷新路径规则
            </button>
          ) : null}
        </div>
      </div>
      {!view.modular ? (
        <p className="scope-note">
          这份历史讲解尚未包含模块职责与跨模块关联。可继续按路径阅读已有修改点。
        </p>
      ) : null}
      {!view.ownership ? (
        <p className="scope-note">
          这份历史讲解没有保存路径规则，以下范围按变更目录整理。
        </p>
      ) : view.ownership.status !== "complete" ? (
        <p className="scope-note">部分路径规则尚不明确，仍可按变更目录阅读。</p>
      ) : null}
      <nav className="change-guide-nav" aria-label="修改点导航">
        <button
          className={
            !point ? "selected guide-overview-button" : "guide-overview-button"
          }
          onClick={() => setSelected(undefined)}
          aria-current={!point ? "page" : undefined}
        >
          改动总览{" "}
          <span>
            {groups.length} 组 ·{" "}
            {groups.reduce((n, g) => n + g.points.length, 0)} 项
          </span>
        </button>
        {groups.map((g, i) => (
          <div className="guide-nav-group" key={g.id}>
            <div className="guide-group-label">
              <span className="mono">{String(i + 1).padStart(2, "0")}</span>
              {g.title}
            </div>
            {g.points.map((p) => (
              <button
                key={p.id}
                className={selected === p.id ? "selected" : ""}
                aria-current={selected === p.id ? "page" : undefined}
                onClick={() => setSelected(p.id)}
              >
                {p.title}
              </button>
            ))}
          </div>
        ))}
        {contextGroups.length ? (
          <div className="guide-context-label">需要了解的背景</div>
        ) : null}
        {contextGroups.map((c) => (
          <div className="guide-nav-group" key={`context:${c.group.id}`}>
            <div className="guide-group-label">{c.group.title}</div>
            {c.group.points.map((p) => (
              <button
                key={p.id}
                className={selected === p.id ? "selected" : ""}
                onClick={() => setSelected(p.id)}
              >
                {p.title} <span className="hint">背景</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="change-guide-content">
        {!point ? (
          <>
            <div className="guide-eyebrow mono">
              // review by intent · {version.head.slice(0, 8)}
            </div>
            <h2>{scoped ? "从你的审查范围开始。" : "从修改目的开始阅读。"}</h2>
            <span className="guide-eyebrow">整体背景</span>
            <p className="guide-intro">{explanation!.summary}</p>
            <div className="guide-overview-groups">
              {groups.map((g, i) => (
                <article key={g.id}>
                  <div className="guide-group-meta">
                    <span className="mono">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{g.category}</span>
                    <span>{g.points.length} 个修改点</span>
                  </div>
                  <h3>{g.title}</h3>
                  <p>{g.summary}</p>
                  {g.responsibility ? (
                    <p className="module-responsibility">
                      职责：{g.responsibility}
                    </p>
                  ) : null}
                  {g.context?.length ? (
                    <div className="module-context-links">
                      {g.context.map((c) => (
                        <p key={c.group}>
                          <span className="hint">
                            关联背景 ·{" "}
                            {explanation.guide!.groups[c.group - 1]?.title}
                          </span>
                          <br />
                          {c.reason}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  {g.reviewFocus?.length ? (
                    <div className="module-focus">
                      <strong>建议审查</strong>
                      <ul>
                        {g.reviewFocus.map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {g.points.map((p) => (
                    <button key={p.id} onClick={() => setSelected(p.id)}>
                      <span>{p.title}</span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </article>
              ))}
            </div>
            {!groups.length ? (
              <p className="hint">这个范围内没有已记录的修改点。</p>
            ) : null}
            {contextGroups.length ? (
              <section className="scope-context" aria-label="跨模块背景">
                <h3>这些修改也需要了解</h3>
                {contextGroups.map((c) => (
                  <article key={c.group.id}>
                    <h4>{c.group.title}</h4>
                    {c.reasons.map((r) => (
                      <p key={r.from}>{r.reason}</p>
                    ))}
                    <p className="hint">{c.group.summary}</p>
                    {c.group.points.map((p) => (
                      <button
                        className="text-button"
                        key={p.id}
                        onClick={() => setSelected(p.id)}
                      >
                        {p.title} ↗
                      </button>
                    ))}
                  </article>
                ))}
              </section>
            ) : null}
          </>
        ) : (
          <article className="change-point" aria-label="修改点说明">
            <div className="guide-group-meta">
              <span>{group?.category}</span>
              <span>{group?.title}</span>
              <span className="mono">
                {index + 1} / {points.length}
              </span>
            </div>
            <h2>{point.title}</h2>
            <p className="guide-intro">{point.summary}</p>
            {contextEntry ? (
              <div className="scope-context-reason">
                <strong>这是理解所选范围所需的背景</strong>
                {contextEntry.reasons.map((r) => (
                  <p key={r.from}>{r.reason}</p>
                ))}
              </div>
            ) : null}
            {group?.responsibility ? (
              <p className="module-responsibility">
                模块职责：{group.responsibility}
              </p>
            ) : null}
            {group?.reviewFocus?.length ? (
              <div className="module-focus">
                <strong>本模块审查重点</strong>
                <ul>
                  {group.reviewFocus.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="guide-before-after">
              <section>
                <h3>修改前</h3>
                <p>{point.before}</p>
              </section>
              <section>
                <h3>修改后</h3>
                <p>{point.after}</p>
              </section>
            </div>
            <section className="guide-detail">
              <h3>为什么这样改</h3>
              <p>{point.rationale}</p>
            </section>
            <section className="guide-detail">
              <h3>影响与待验证</h3>
              {point.risks.length ? (
                <ul>
                  {point.risks.map((risk, i) => (
                    <li key={i}>{risk}</li>
                  ))}
                </ul>
              ) : (
                <p className="subtle">
                  未列出额外风险；这不代表已经完成运行验证。
                </p>
              )}
            </section>
            <section className="guide-detail">
              <h3>
                源码证据{" "}
                <span className="mono">{version.head.slice(0, 8)}</span>
              </h3>
              <div className="guide-references">
                {refs.map((ref) => (
                  <button
                    key={ref.id}
                    className="reference-link mono"
                    onClick={() => onReference(ref)}
                  >
                    {ref.path}:{ref.start}
                    {ref.end !== ref.start ? `–${ref.end}` : ""} ·{" "}
                    {ref.side === "old" ? "旧" : "新"} ↗
                  </button>
                ))}
              </div>
              {!refs.length ? (
                <p className="subtle">
                  这个修改点没有可直接跳转的源码证据；请结合 Diff
                  与待验证项阅读。
                </p>
              ) : null}
            </section>
            <section className="guide-detail">
              <h3>
                相关文件与 Diff <span>{files.length}</span>
              </h3>
              {scoped ? (
                <p className="scope-owned">
                  所选范围：
                  {point.files
                    .filter((f) => view.focusFiles.includes(f))
                    .join("、") || "关联背景"}
                  。保留本修改点的完整逻辑。
                </p>
              ) : null}
              {files.map(renderDiff)}
            </section>
            <footer className="guide-point-nav">
              <button
                disabled={index === 0}
                onClick={() => setSelected(points[index - 1].id)}
              >
                ← 上一项
              </button>
              <button onClick={() => setSelected(undefined)}>返回总览</button>
              <button
                disabled={index === points.length - 1}
                onClick={() => setSelected(points[index + 1].id)}
              >
                下一项 →
              </button>
            </footer>
          </article>
        )}
      </div>
    </section>
  );
}
