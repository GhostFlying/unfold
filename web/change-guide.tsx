import { useState, type ReactNode } from "react";
import type {
  Explanation,
  FileDiff,
  Reference,
  Snapshot,
} from "../src/types.js";

export function ChangeGuideView({
  explanation,
  version,
  onReference,
  renderDiff,
}: {
  explanation?: Omit<Explanation, "threadId">;
  version: Snapshot;
  onReference: (ref: Reference) => void;
  renderDiff: (file: FileDiff) => ReactNode;
}) {
  const [selected, setSelected] = useState<string>();
  const groups = explanation?.guide?.groups;
  if (!groups?.length)
    return (
      <section className="guide-empty">
        <span className="mono subtle">// logical change guide</span>
        <h2>这份讲解还没有改动导览。</h2>
        <p>
          新生成的讲解会按修改目的分组，并逐项说明修改前后、原因与源码证据。已有讲解和
          Diff 仍可阅读。
        </p>
      </section>
    );
  const points = groups.flatMap((g) => g.points);
  const group = groups.find((g) => g.points.some((p) => p.id === selected));
  const point = points.find((p) => p.id === selected);
  const index = point ? points.indexOf(point) : -1;
  const refs = explanation!.references.filter((r) =>
    point?.referenceIds.includes(r.id),
  );
  const files = version.files.filter(
    (f) => point?.files.includes(f.path) || point?.files.includes(f.oldPath),
  );
  return (
    <section className="change-guide" aria-label="逻辑改动导览">
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
            {groups.length} 组 · {points.length} 项
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
      </nav>
      <div className="change-guide-content">
        {!point ? (
          <>
            <div className="guide-eyebrow mono">
              // review by intent · {version.head.slice(0, 8)}
            </div>
            <h2>从修改目的开始阅读。</h2>
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
                  {g.points.map((p) => (
                    <button key={p.id} onClick={() => setSelected(p.id)}>
                      <span>{p.title}</span>
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </article>
              ))}
            </div>
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
