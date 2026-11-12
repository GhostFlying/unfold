import { useEffect, useState } from "react";
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
    [notice, setNotice] = useState("");
  useEffect(() => {
    api("/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
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
              try {
                const r = await api("/config", "PATCH", {
                  defaultBackend: config.defaultBackend,
                  shareBaseUrl: config.shareBaseUrl,
                  ownerBaseUrl: config.ownerBaseUrl,
                  codebaseHosts: config.codebaseHosts,
                  agents: config.agents,
                });
                setNotice(
                  r.restartConnectorRequired
                    ? "已保存。请重启 connector 以应用接入配置。"
                    : "已保存",
                );
                await onSave();
              } catch (e: any) {
                setError(e.message);
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
                key={b}
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
            {notice ? <p className="notice">{notice}</p> : null}
            <footer>
              <button className="primary">保存设置</button>
            </footer>
          </form>
        ) : (
          <p>读取设置…</p>
        )}
      </section>
    </div>
  );
}
