import { useEffect, useState } from "react";
import type {
  AgentModel,
  Backend,
  ModelProfile,
  Review,
  Run,
} from "../src/types.js";
import { api } from "./api.js";

type Settings = {
  backend: Backend;
  backendOverride?: Backend;
  overrides: Partial<Record<Backend, ModelProfile>>;
};
type Defaults = {
  defaultBackend: Backend;
  agents: Record<Backend, ModelProfile>;
};
type SettingsPatch = {
  backend?: Backend | null;
  agentOverrides?: Partial<
    Record<Backend, { model?: string | null; effort?: string | null }>
  >;
};

export function ReviewAgentControls({
  reviewId,
  regenerate,
  disabled,
  active,
  onSaved,
  onStarted,
  onPendingChange,
}: {
  reviewId: string;
  regenerate: boolean;
  disabled: boolean;
  active: boolean;
  onSaved: (review: Review) => void;
  onStarted: (run: Run) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [defaults, setDefaults] = useState<Defaults>();
  const [catalog, setCatalog] = useState<{
    backend: Backend;
    models: AgentModel[];
  }>();
  const [loadAttempt, setLoadAttempt] = useState(0),
    [catalogAttempt, setCatalogAttempt] = useState(0);
  const [error, setError] = useState(""),
    [catalogError, setCatalogError] = useState("");
  const [pending, setPending] = useState<SettingsPatch>();
  const [saving, setSaving] = useState(false),
    [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let current = true;
    setError("");
    Promise.all([
      api<Defaults>("/config"),
      api<Settings>(`/reviews/${reviewId}/agent`),
    ])
      .then(([config, value]) => {
        if (!current) return;
        setDefaults(config);
        setSettings(value);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [reviewId, loadAttempt]);

  const backend = settings?.backend;
  useEffect(() => {
    if (!backend) return;
    let current = true;
    setCatalogError("");
    setCatalog(undefined);
    api<{ models: AgentModel[] }>(`/agents/${backend}/models`)
      .then((value) => {
        if (current) setCatalog({ backend, models: value.models });
      })
      .catch((e) => {
        if (current) setCatalogError(e.message);
      });
    return () => {
      current = false;
    };
  }, [backend, catalogAttempt]);

  const models = catalog?.backend === backend ? catalog?.models || [] : [];
  const inherited = backend ? defaults?.agents[backend] || {} : {};
  const override = backend ? settings?.overrides[backend] || {} : {};
  const requestedModel = override.model || inherited.model;
  const model = requestedModel
    ? models.find((m) => m.model === requestedModel || m.id === requestedModel)
    : models.find((m) => m.isDefault) || models[0];
  const effort = override.effort || inherited.effort;
  const valid =
    !!model && (!effort || model.efforts.some((e) => e.effort === effort));
  const blocked = saving || submitting || !!pending || !settings || !valid;
  const locked = disabled || active || saving || submitting || !!pending;
  useEffect(() => {
    onPendingChange(blocked);
  }, [blocked, onPendingChange]);

  async function save(patch: SettingsPatch) {
    setSaving(true);
    setError("");
    try {
      const review = await api<Review>(`/reviews/${reviewId}`, "PATCH", patch);
      const value = await api<Settings>(`/reviews/${reviewId}/agent`);
      setSettings(value);
      setPending(undefined);
      onSaved(review);
    } catch (e: any) {
      setError(`MR 设置保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  }
  function change(patch: SettingsPatch) {
    if (!settings || !defaults || locked) return;
    const overrides = { ...settings.overrides };
    for (const [key, value] of Object.entries(patch.agentOverrides || {})) {
      const b = key as Backend;
      const next = { ...overrides[b] };
      for (const field of ["model", "effort"] as const) {
        if (value[field] === null) delete next[field];
        else if (value[field] !== undefined) next[field] = value[field];
      }
      overrides[b] = next;
    }
    setSettings({
      ...settings,
      backendOverride:
        patch.backend !== undefined
          ? patch.backend || undefined
          : settings.backendOverride,
      backend:
        patch.backend !== undefined
          ? patch.backend || defaults.defaultBackend
          : settings.backend,
      overrides,
    });
    setPending(patch);
    void save(patch);
  }

  return (
    <section
      className="review-agent-controls"
      aria-label="当前 MR 的 Agent 设置"
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (blocked || disabled || active) return;
          setSubmitting(true);
          setError("");
          try {
            onStarted(
              await api<Run>(`/reviews/${reviewId}/analyze`, "POST", {}),
            );
          } catch (e: any) {
            setError(e.message);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label>
          Agent
          <select
            aria-label="MR Agent"
            disabled={locked || !settings}
            value={settings?.backendOverride || ""}
            onChange={(e) =>
              change({ backend: (e.target.value as Backend) || null })
            }
          >
            <option value="">
              继承全局 · {defaults?.defaultBackend || "读取中…"}
            </option>
            <option value="traex">TraeX</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="agent-model-control">
          模型
          <select
            aria-label="MR 模型"
            disabled={locked || !models.length}
            value={override.model || ""}
            onChange={(e) => {
              const value = e.target.value;
              const targetModel = value || inherited.model;
              const nextModel = targetModel
                ? models.find(
                    (m) => m.model === targetModel || m.id === targetModel,
                  )
                : models.find((m) => m.isDefault) || models[0];
              change({
                agentOverrides: {
                  [backend!]: {
                    model: value || null,
                    ...(!effort ||
                    nextModel?.efforts.some((entry) => entry.effort === effort)
                      ? {}
                      : { effort: nextModel?.defaultEffort || null }),
                  },
                },
              });
            }}
          >
            <option value="">
              {!models.length
                ? "正在读取模型…"
                : inherited.model
                  ? `继承全局 · ${inherited.model}`
                  : `后端默认 · ${models.find((m) => m.isDefault)?.displayName || models[0]?.displayName}`}
            </option>
            {override.model && !model && models.length ? (
              <option value={override.model}>
                {override.model}（当前不可用）
              </option>
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
            aria-label="MR thinking effort"
            disabled={locked || !model}
            value={override.effort || ""}
            onChange={(e) =>
              change({
                agentOverrides: {
                  [backend!]: { effort: e.target.value || null },
                },
              })
            }
          >
            <option value="">
              {inherited.effort
                ? `继承全局 · ${inherited.effort}`
                : `模型默认${model?.defaultEffort ? ` · ${model.defaultEffort}` : ""}`}
            </option>
            {override.effort &&
            !model?.efforts.some((e) => e.effort === override.effort) ? (
              <option value={override.effort}>
                {override.effort}（当前不可用）
              </option>
            ) : null}
            {model?.efforts.map((e) => (
              <option key={e.effort} value={e.effort}>
                {e.effort}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={disabled || active || blocked}>
          {active
            ? "分析中…"
            : submitting
              ? "正在启动…"
              : regenerate
                ? "重新讲解"
                : "生成讲解"}{" "}
          <span>✳</span>
        </button>
      </form>
      <div className="agent-settings-feedback">
        <span className="hint" role="status">
          {saving
            ? "正在保存 MR 设置…"
            : pending
              ? "设置尚未保存"
              : settings
                ? "自动保存 · 用于此 MR 的后续讲解与追问"
                : "正在读取 MR 设置…"}
        </span>
        {error ? (
          <span className="error" role="alert">
            {error}
          </span>
        ) : null}
        {pending && !saving ? (
          <>
            <button
              type="button"
              className="text-button"
              disabled={disabled || active}
              onClick={() => void save(pending)}
            >
              重试保存
            </button>
            <button
              type="button"
              className="text-button"
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  setSettings(
                    await api<Settings>(`/reviews/${reviewId}/agent`),
                  );
                  setPending(undefined);
                } catch (e: any) {
                  setError(`MR 设置读取失败：${e.message}`);
                } finally {
                  setSaving(false);
                }
              }}
            >
              重新读取已保存设置
            </button>
          </>
        ) : null}
        {!settings && error ? (
          <button
            className="text-button"
            onClick={() => setLoadAttempt((n) => n + 1)}
          >
            重新读取设置
          </button>
        ) : null}
        {catalogError ? (
          <span className="error" role="alert">
            模型读取失败：{catalogError}
          </span>
        ) : null}
        {catalogError || (catalog && !models.length) ? (
          <button
            className="text-button"
            onClick={() => setCatalogAttempt((n) => n + 1)}
          >
            重新读取模型
          </button>
        ) : null}
        {models.length > 0 && !valid ? (
          <span className="error" role="alert">
            当前模型或 effort 不可用，请重新选择。
          </span>
        ) : null}
      </div>
    </section>
  );
}
