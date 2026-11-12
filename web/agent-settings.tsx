import { useEffect, useState } from "react";
import type { AgentModel, Backend, ModelProfile } from "../src/types.js";
import { api } from "./api.js";

export function ProfileFields({
  backend,
  value,
  onChange,
  inherited,
}: {
  backend: Backend;
  value: ModelProfile;
  onChange: (next: ModelProfile) => void;
  inherited?: ModelProfile;
}) {
  const [models, setModels] = useState<AgentModel[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setModels([]);
    setError("");
    api<{ models: AgentModel[] }>(`/agents/${backend}/models`)
      .then((r) => {
        if (active) setModels(r.models);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [backend]);
  const model =
    models.find((m) => m.model === (value.model || inherited?.model)) ||
    models.find((m) => m.isDefault);
  return (
    <>
      <label>
        {backend === "traex" ? "TraeX" : "Codex"} 模型
        <select
          aria-label={`${backend} 模型`}
          value={value.model || ""}
          onChange={(e) =>
            onChange({
              ...value,
              model: e.target.value || undefined,
              effort: undefined,
            })
          }
        >
          <option value="">
            {inherited?.model
              ? `继承全局 · ${inherited.model}`
              : "后端默认模型"}
          </option>
          {value.model && !models.some((m) => m.model === value.model) ? (
            <option value={value.model}>{value.model}</option>
          ) : null}
          {models.map((m) => (
            <option key={m.id} value={m.model}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Thinking effort
        <select
          aria-label={`${backend} thinking effort`}
          value={value.effort || ""}
          onChange={(e) =>
            onChange({ ...value, effort: e.target.value || undefined })
          }
        >
          <option value="">
            {inherited?.effort
              ? `继承全局 · ${inherited.effort}`
              : `模型默认${model?.defaultEffort ? ` · ${model.defaultEffort}` : ""}`}
          </option>
          {value.effort &&
          !model?.efforts.some((e) => e.effort === value.effort) ? (
            <option value={value.effort}>{value.effort}（待校验）</option>
          ) : null}
          {model?.efforts.map((e) => (
            <option key={e.effort} value={e.effort}>
              {e.effort}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="error" role="alert">
          模型列表读取失败：{error}
        </p>
      ) : null}
      {!models.length && !error ? (
        <p className="hint">正在读取后端模型与支持的 effort…</p>
      ) : null}
    </>
  );
}

export function ReviewAgentSettings({
  reviewId,
  onClose,
  onSave,
}: {
  reviewId: string;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const [config, setConfig] = useState<any>();
  const [settings, setSettings] = useState<any>();
  const [backend, setBackend] = useState<Backend>();
  const [override, setOverride] = useState("");
  const [profiles, setProfiles] = useState<
    Partial<Record<Backend, ModelProfile>>
  >({});
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([api("/config"), api(`/reviews/${reviewId}/agent`)])
      .then(([c, s]) => {
        setConfig(c);
        setSettings(s);
        setOverride(s.backendOverride || "");
        setBackend(s.backend);
        setProfiles(s.overrides);
      })
      .catch((e) => setError(e.message));
  }, [reviewId]);
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-title"
      >
        <header>
          <h2 id="agent-title">此 MR 的 Agent 设置</h2>
          <button
            className="quiet"
            onClick={onClose}
            aria-label="关闭 Agent 设置"
          >
            ×
          </button>
        </header>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        {config && settings && backend ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await api(`/reviews/${reviewId}`, "PATCH", {
                  backend: override || null,
                  agentOverrides: Object.fromEntries(
                    Object.entries(profiles).map(([b, p]) => [
                      b,
                      { model: p.model || null, effort: p.effort || null },
                    ]),
                  ),
                });
                await onSave();
                onClose();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <label>
              分析后端
              <select
                aria-label="MR 后端覆盖"
                value={override}
                onChange={(e) => {
                  setOverride(e.target.value);
                  setBackend(
                    (e.target.value || config.defaultBackend) as Backend,
                  );
                }}
              >
                <option value="">继承全局 · {config.defaultBackend}</option>
                <option value="traex">TraeX</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <ProfileFields
              backend={backend}
              value={profiles[backend] || {}}
              inherited={config.agents[backend]}
              onChange={(p) => setProfiles({ ...profiles, [backend]: p })}
            />
            <p className="hint">
              未覆盖的配置继承全局值。仅影响后续运行；已有讲解与问答保留实际使用的模型和
              effort。
            </p>
            <footer>
              <button className="primary">保存 MR 设置</button>
            </footer>
          </form>
        ) : (
          <p>读取设置…</p>
        )}
      </section>
    </div>
  );
}
