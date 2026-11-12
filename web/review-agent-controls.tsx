import { useEffect, useState } from "react";
import type {
  AgentModel,
  Backend,
  ModelProfile,
  ReviewModelProfile,
  Review,
  Run,
} from "../src/types.js";
import { api } from "./api.js";

type Settings = {
  backend: Backend;
  backendOverride?: Backend;
  overrides: Partial<Record<Backend, ReviewModelProfile>>;
};
type Defaults = {
  defaultBackend: Backend;
  agents: Record<Backend, ModelProfile>;
};
type SettingsPatch = {
  backend?: Backend | null;
  agentOverrides?: Partial<
    Record<
      Backend,
      {
        model?: string | null;
        effort?: string | null;
        modelDefaultEffort?: boolean;
      }
    >
  >;
};

export function ReviewAgentControls({
  reviewId,
  sourceKind = "MR",
  regenerate,
  disabled,
  active,
  workspaceBusy = false,
  onSaved,
  onStarted,
  onPendingChange,
}: {
  reviewId: string;
  sourceKind?: "MR" | "PR";
  regenerate: boolean;
  disabled: boolean;
  active: boolean;
  workspaceBusy?: boolean;
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
  const [adjustment, setAdjustment] = useState("");
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
  const effort = override.modelDefaultEffort
    ? undefined
    : override.effort || inherited.effort;
  const defaultEffort = model?.efforts.some(
    (entry) => entry.effort === model.defaultEffort,
  )
    ? model.defaultEffort
    : undefined;
  const valid =
    !!model && (!effort || model.efforts.some((e) => e.effort === effort));
  const blocked = saving || submitting || !!pending || !settings || !valid;
  const locked = disabled || active || saving || submitting;
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
      setError(`${sourceKind} 设置保存失败：${e.message}`);
    } finally {
      setSaving(false);
    }
  }
  async function change(patch: SettingsPatch) {
    if (!settings || !defaults || locked) return;
    setError("");
    setAdjustment("");
    const nextBackend =
      patch.backend !== undefined
        ? patch.backend || defaults.defaultBackend
        : settings.backend;
    let available = models;
    if (nextBackend !== backend) {
      setSaving(true);
      try {
        available = (
          await api<{ models: AgentModel[] }>(`/agents/${nextBackend}/models`)
        ).models;
      } catch (e: any) {
        setError(`模型读取失败：${e.message}`);
        setSaving(false);
        return;
      }
    }
    const overrides = { ...settings.overrides };
    const profile = { ...overrides[nextBackend] };
    const changes = patch.agentOverrides?.[nextBackend];
    if (changes) {
      for (const field of ["model", "effort"] as const) {
        if (changes[field] === null) delete profile[field];
        else if (changes[field] !== undefined) profile[field] = changes[field];
      }
      if (changes.effort !== undefined) delete profile.modelDefaultEffort;
      if (changes.modelDefaultEffort) {
        profile.modelDefaultEffort = true;
        delete profile.effort;
      } else if (changes.modelDefaultEffort === false)
        delete profile.modelDefaultEffort;
    }
    const inheritedProfile = defaults.agents[nextBackend];
    const wanted = profile.model || inheritedProfile.model;
    const nextModel = wanted
      ? available.find((entry) => entry.model === wanted || entry.id === wanted)
      : available.find((entry) => entry.isDefault) || available[0];
    const nextEffort = profile.modelDefaultEffort
      ? undefined
      : profile.effort || inheritedProfile.effort;
    if (
      nextModel &&
      nextEffort &&
      !nextModel.efforts.some((entry) => entry.effort === nextEffort)
    ) {
      delete profile.effort;
      profile.modelDefaultEffort = true;
      setAdjustment("已改用此模型的默认思考强度");
    }
    overrides[nextBackend] = profile;
    setSettings({
      ...settings,
      backend: nextBackend,
      backendOverride:
        patch.backend !== undefined
          ? patch.backend || undefined
          : settings.backendOverride,
      overrides,
    });
    const complete: SettingsPatch = {
      backend:
        patch.backend !== undefined
          ? patch.backend
          : settings.backendOverride || null,
      agentOverrides: {
        [nextBackend]: {
          model: profile.model || null,
          effort: profile.effort || null,
          modelDefaultEffort: !!profile.modelDefaultEffort,
        },
      },
    };
    setPending(complete);
    await save(complete);
  }

  return (
    <section
      className="review-agent-controls"
      aria-label={`当前 ${sourceKind} 的 Agent 设置`}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (blocked || disabled || active || workspaceBusy) return;
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
          <span>Agent</span>
          <select
            aria-label={`${sourceKind} Agent`}
            disabled={locked || !settings}
            value={settings?.backendOverride || ""}
            onChange={(e) =>
              change({ backend: (e.target.value as Backend) || null })
            }
          >
            <option value="">
              {defaults
                ? `${defaults.defaultBackend === "codex" ? "Codex" : "TraeX"} · 全局`
                : "读取中…"}
            </option>
            <option value="traex">TraeX</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="agent-model-control">
          <span>模型</span>
          <select
            aria-label={`${sourceKind} 模型`}
            disabled={locked || !models.length}
            value={override.model || ""}
            title={requestedModel || model?.displayName}
            onChange={(e) =>
              void change({
                agentOverrides: {
                  [backend!]: { model: e.target.value || null },
                },
              })
            }
          >
            <option value="">
              {!models.length
                ? "正在读取模型…"
                : inherited.model
                  ? `${inherited.model} · 全局`
                  : `${models.find((m) => m.isDefault)?.displayName || models[0]?.displayName} · 默认`}
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
          <span>思考</span>
          <select
            aria-label={`${sourceKind} thinking effort`}
            disabled={locked || !model}
            value={
              override.modelDefaultEffort
                ? "model-default"
                : override.effort || ""
            }
            onChange={(e) =>
              void change({
                agentOverrides: {
                  [backend!]: {
                    effort:
                      e.target.value === "model-default"
                        ? null
                        : e.target.value || null,
                    modelDefaultEffort: e.target.value === "model-default",
                  },
                },
              })
            }
          >
            <option value="">
              {inherited.effort
                ? `${inherited.effort} · 全局`
                : `默认${defaultEffort ? ` · ${defaultEffort}` : ""}`}
            </option>
            <option value="model-default">
              默认{defaultEffort ? ` · ${defaultEffort}` : ""}
            </option>
            {override.effort &&
            !model?.efforts.some(
              (entry) => entry.effort === override.effort,
            ) ? (
              <option value={override.effort}>
                {override.effort}（不支持）
              </option>
            ) : null}
            {model?.efforts.map((e) => (
              <option key={e.effort} value={e.effort}>
                {e.effort}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={disabled || active || workspaceBusy || blocked}
        >
          {active
            ? "分析中…"
            : workspaceBusy
              ? "Agent 忙碌"
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
            ? `正在保存 ${sourceKind} 设置…`
            : pending
              ? "设置尚未保存"
              : settings
                ? adjustment
                : `正在读取 ${sourceKind} 设置…`}
        </span>
        {error || catalogError || (models.length > 0 && !valid) ? (
          <span className="error" role="alert">
            {error ||
              catalogError ||
              "请选择此模型支持的思考强度，或使用默认值。"}
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
                  setError(`${sourceKind} 设置读取失败：${e.message}`);
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
        {catalogError || (catalog && !models.length) ? (
          <button
            className="text-button"
            onClick={() => setCatalogAttempt((n) => n + 1)}
          >
            重新读取模型
          </button>
        ) : null}
      </div>
    </section>
  );
}
