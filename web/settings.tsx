import { useEffect, useState } from "react";
import type { ConfigApplication } from "../src/types.js";
import { ProfileFields } from "./agent-settings.js";
import { api } from "./api.js";
export function Settings({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [config, setConfig] = useState<any>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState(false),
    [application, setApplication] = useState<ConfigApplication>();
  useEffect(() => {
    Promise.all([api("/config"), api<ConfigApplication>("/config/status")])
      .then(([config, application]) => {
        setConfig(config);
        setApplication(application);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (
      !application ||
      !["pending", "applying", "unavailable"].includes(application.state)
    )
      return;
    const timer = setTimeout(() => {
      api<ConfigApplication>("/config/status")
        .then(setApplication)
        .catch((e) =>
          setApplication({ state: "unavailable", error: e.message }),
        );
    }, 1500);
    return () => clearTimeout(timer);
  }, [application]);
  const applicationMessage =
    application?.state === "applied"
      ? "配置已生效"
      : application?.state === "pending"
        ? "已保存，当前任务结束后自动生效"
        : application?.state === "applying"
          ? "已保存，正在应用并检查连接…"
          : application?.state === "failed"
            ? "已保存，但应用失败"
            : application?.state === "unavailable"
              ? "已保存，暂时无法确认生效状态"
              : "";
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header>
          <h2 id="settings-title">工作区设置</h2>
          <button className="quiet" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </header>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {config ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              setError("");
              setNotice("");
              try {
                const r = await api("/config", "PATCH", {
                  defaultBackend: config.defaultBackend,
                  shareBaseUrl: config.shareBaseUrl,
                  ownerBaseUrl: config.ownerBaseUrl,
                  codebaseHosts: config.codebaseHosts,
                  agents: config.agents,
                });
                setApplication(r.application);
                setNotice("已保存");
                await onSave();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <label>
              默认分析后端
              <select
                value={config.defaultBackend}
                onChange={(e) =>
                  setConfig({ ...config, defaultBackend: e.target.value })
                }
              >
                <option value="traex">TraeX</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              Codebase 域名
              <input
                value={config.codebaseHosts.join(", ")}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    codebaseHosts: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              公司内网分享地址
              <input
                value={config.shareBaseUrl}
                placeholder="https://review.company.example"
                onChange={(e) =>
                  setConfig({ ...config, shareBaseUrl: e.target.value })
                }
              />
            </label>
            <p className="hint">固定分享入口独立于所有者的 Tailscale 访问。</p>
            <label>
              所有者访问地址
              <input
                value={config.ownerBaseUrl}
                onChange={(e) =>
                  setConfig({ ...config, ownerBaseUrl: e.target.value })
                }
              />
            </label>
            {(["traex", "codex"] as const).map((b) => (
              <ProfileFields
                key={`${b}:${application?.appliedRevision || "initial"}`}
                backend={b}
                value={config.agents[b]}
                onChange={(p) =>
                  setConfig({
                    ...config,
                    agents: {
                      ...config.agents,
                      [b]: {
                        ...config.agents[b],
                        model: p.model,
                        effort: p.effort,
                      },
                    },
                  })
                }
              />
            ))}
            {notice || (application && application.state !== "applied") ? (
              <div
                role="status"
                aria-live="polite"
                className={
                  application?.state === "failed" ||
                  application?.state === "unavailable"
                    ? "error"
                    : "notice"
                }
              >
                <p>{applicationMessage || notice}</p>
                {application?.error ? <p>{application.error}</p> : null}
              </div>
            ) : null}
            <footer>
              {application &&
              ["failed", "unavailable"].includes(application.state) ? (
                <button
                  type="button"
                  className="quiet"
                  disabled={saving}
                  onClick={async () => {
                    setSaving(true);
                    setError("");
                    try {
                      setApplication(
                        await api<ConfigApplication>(
                          "/config/apply",
                          "POST",
                          {},
                        ),
                      );
                    } catch (e: any) {
                      setError(e.message);
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  重试应用
                </button>
              ) : null}
              <button className="primary" disabled={saving}>
                {saving ? "正在保存并应用…" : "保存设置"}
              </button>
            </footer>
          </form>
        ) : (
          <p>读取设置…</p>
        )}
      </section>
    </div>
  );
}
