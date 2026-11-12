import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, nav } from "./api.js";
import { ReviewPage } from "./review.js";
import { Settings } from "./settings.js";
import type { ActiveOperation, Backend, Review } from "../src/types.js";
import "./style.css";

function Logo() {
  return (
    <a
      className="wordmark"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        nav("/");
      }}
    >
      <span>+</span>unfold<span className="logo-dot">.</span>
    </a>
  );
}
function App() {
  const [route, setRoute] = useState(location.pathname),
    [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(
      null,
    ),
    [bootstrap, setBootstrap] = useState<any>(),
    [reviews, setReviews] = useState<Review[]>([]),
    [backend, setBackend] = useState<Backend | "">(""),
    [defaultBackend, setDefaultBackend] = useState<Backend>("traex"),
    [settings, setSettings] = useState(false),
    [settingsRevision, setSettingsRevision] = useState(0),
    [error, setError] = useState(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState("");
  const reload = async () => {
    const b = await api("/bootstrap");
    setBootstrap(b);
    if (b.authenticated) {
      const [r, c] = await Promise.all([
        api<Review[]>("/reviews"),
        api("/config"),
      ]);
      setReviews(r);
      setDefaultBackend(c.defaultBackend);
    }
  };
  useEffect(() => {
    reload().catch((e) => setError(e.message));
    const pop = () => setRoute(location.pathname);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const isOwner = !!bootstrap?.authenticated,
    match = /^\/r\/([^/]+)(?:\/v\/([^/]+))?$/.exec(route);
  useEffect(() => {
    if (!isOwner) {
      setActiveOperation(null);
      return;
    }
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api<{ active: ActiveOperation | null }>(
          "/activity",
        );
        if (mounted) setActiveOperation(result.active);
      } catch {
        /* Race-time start errors still enforce the server's slot. */
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [isOwner]);
  const importReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<Review>("/reviews", "POST", {
        url,
        backend: backend || undefined,
      });
      await reload();
      nav(`/r/${r.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <header className="app-header">
        <Logo />
        <span className="header-separator" />
        <span className="header-subtitle">changes, understood.</span>
        <div className="header-right">
          {isOwner ? (
            <>
              <button className="quiet" onClick={() => nav("/")}>
                改动记录
              </button>
              <button className="quiet" onClick={() => setSettings(true)}>
                设置
              </button>
              <button
                className="quiet"
                onClick={async () => {
                  await api("/logout", "POST", {});
                  await reload();
                  nav("/");
                }}
              >
                锁定
              </button>
            </>
          ) : (
            <span className="subtle mono">
              {bootstrap?.mode === "viewer" ? "read-only" : "owner workspace"}
            </span>
          )}
          <a
            className="quiet link"
            href="https://github.com/GhostFlying/unfold"
            target="_blank"
            rel="noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </header>
      {isOwner && activeOperation ? (
        <aside
          className="workspace-activity"
          aria-label="正在运行的任务"
          role="status"
        >
          <span className="activity-label">
            {activeOperation.stopping
              ? "正在停止"
              : activeOperation.state === "awaiting_approval"
                ? "等待审批"
                : activeOperation.kind === "analysis"
                  ? "正在生成讲解"
                  : "正在回答追问"}
          </span>
          <span className="activity-title">{activeOperation.title}</span>
          <span className="subtle">{activeOperation.backend}</span>
          <a
            href={`/r/${activeOperation.reviewId}`}
            onClick={(e) => {
              e.preventDefault();
              nav(`/r/${activeOperation.reviewId}`);
            }}
          >
            查看进度 →
          </a>
        </aside>
      ) : null}
      {error ? (
        <div className="global-error" role="alert">
          {error}
          <button className="quiet" onClick={() => setError("")}>
            关闭
          </button>
        </div>
      ) : null}
      {!bootstrap ? (
        <main className="home">
          <p className="subtle">正在打开工作区…</p>
        </main>
      ) : match ? (
        <ReviewPage
          key={route}
          id={match[1]}
          explanationId={match[2]}
          owner={isOwner}
          workspaceBusy={
            !!activeOperation && activeOperation.reviewId !== match[1]
          }
          settingsRevision={settingsRevision}
          onChange={reload}
        />
      ) : bootstrap.mode === "owner" && !isOwner ? (
        <main className="auth-page">
          <span className="mono accent">// personal workspace</span>
          <h1>继续你的审查。</h1>
          <p className="muted">输入本机所有者密钥，打开工作区。</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/login", "POST", { token: key });
                setKey("");
                await reload();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <label className="sr-only" htmlFor="owner-key">
              所有者密钥
            </label>
            <input
              id="owner-key"
              type="password"
              autoComplete="current-password"
              placeholder="所有者密钥"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button className="primary">
              打开工作区 <span>↗</span>
            </button>
          </form>
          <p className="hint mono">unfold auth token</p>
        </main>
      ) : !isOwner ? (
        <main className="auth-page">
          <h1>展开一份改动。</h1>
          <p className="muted">通过分享给你的固定链接，阅读讲解与源码证据。</p>
          <p className="hint">这是只读入口。</p>
        </main>
      ) : (
        <main className="home">
          <section className="home-intro">
            <div>
              <div className="intro-symbol mono">
                @@ <span>unfold</span>
              </div>
              <h1>
                把改动，
                <br />
                展开来看<span className="accent">。</span>
              </h1>
              <p className="intro-description">
                从真实代码出发，看清设计、行为与取舍。
                <br />
                理解之后，再写下你的 Review。
              </p>
              <form className="import-form" onSubmit={importReview}>
                <label className="sr-only" htmlFor="mr-url">
                  MR 或 PR 链接
                </label>
                <input
                  id="mr-url"
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="粘贴 Codebase MR 或 GitHub PR 链接…"
                />
                <select
                  aria-label="分析后端"
                  value={backend}
                  onChange={(e) => setBackend(e.target.value as Backend)}
                >
                  <option value="">继承全局 · {defaultBackend}</option>
                  <option value="traex">TraeX</option>
                  <option value="codex">Codex</option>
                </select>
                <button className="primary" disabled={busy}>
                  {busy ? "读取中…" : "打开 →"}
                </button>
              </form>
              <p className="hint">先阅读 Diff，再让 Agent 带你理解改动。</p>
            </div>
            <div className="intro-note">
              <span className="mono subtle">// a change, in context</span>
              <div className="flow-line">
                <span className="line-no">01</span>
                <span>真实代码</span>
                <i>→</i>
                <span className="accent">设计与行为</span>
              </div>
              <div className="flow-line">
                <span className="line-no">02</span>
                <span>追问与证据</span>
                <i>→</i>
                <span>形成判断</span>
              </div>
              <div className="flow-line">
                <span className="line-no">03</span>
                <span>确认评论</span>
                <i>→</i>
                <span>回到原讨论</span>
              </div>
              <p>
                问 Agent，留在这里。
                <br />
                提交评论，才写入原 MR / PR。
              </p>
            </div>
          </section>
          <section className="review-list">
            <div className="section-heading">
              <span className="mono subtle">// your changes</span>
              <span className="hint">{reviews.length} 份改动</span>
            </div>
            {reviews.length ? (
              reviews.map((r) => (
                <a
                  key={r.id}
                  href={`/r/${r.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    nav(`/r/${r.id}`);
                  }}
                  className="review-row"
                >
                  <span className="branch-icon" aria-hidden="true">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="6" cy="5" r="2" />
                      <circle cx="6" cy="19" r="2" />
                      <circle cx="18" cy="6" r="2" />
                      <path d="M6 7v10m0-4h5a7 7 0 0 0 7-5" />
                    </svg>
                  </span>
                  <div>
                    <span className="review-row-title">{r.title}</span>
                    <span className="review-row-meta mono">
                      {r.target.repo} <span>#{r.target.number}</span>
                    </span>
                  </div>
                  <span className="review-row-backend">
                    {r.backend === "traex" ? "TraeX" : "Codex"}
                  </span>
                  <span className="row-arrow">↗</span>
                </a>
              ))
            ) : (
              <p className="empty-records">
                还没有导入的改动。从上方粘贴一个 MR 或 PR 链接开始。
              </p>
            )}
          </section>
          <footer className="home-footer">
            <span className="mono subtle">
              unfold · a personal review workspace
            </span>
            <span>
              Inspired by{" "}
              <a
                href="https://github.com/antfu/pulls.review"
                target="_blank"
                rel="noreferrer"
              >
                pulls.review
              </a>
              ,{" "}
              <a
                href="https://github.com/cursor/plugins/tree/main/pr-review-canvas"
                target="_blank"
                rel="noreferrer"
              >
                PR Review Canvas
              </a>{" "}
              &{" "}
              <a
                href="https://github.com/nicobailon/visual-explainer"
                target="_blank"
                rel="noreferrer"
              >
                visual-explainer
              </a>
              .
            </span>
          </footer>
        </main>
      )}
      {settings ? (
        <Settings
          onClose={() => setSettings(false)}
          onSave={async () => {
            await reload();
            setSettingsRevision((revision) => revision + 1);
          }}
        />
      ) : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
