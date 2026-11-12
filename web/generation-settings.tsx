import { useEffect, useState } from "react";
import type { AgentModel, Backend, ModelProfile, Run } from "../src/types.js";
import { api } from "./api.js";

type Settings = { backend: Backend; profiles: Record<Backend, ModelProfile> };
export function GenerationSettings({
  reviewId,
  regenerate,
  onClose,
  onStarted,
}: {
  reviewId: string;
  regenerate: boolean;
  onClose: () => void;
  onStarted: (run: Run) => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [backend, setBackend] = useState<Backend>();
  const [profiles, setProfiles] = useState<
    Partial<Record<Backend, ModelProfile>>
  >({});
  const [catalog, setCatalog] = useState<{
    backend: Backend;
    models: AgentModel[];
  }>();
  const [settingsAttempt, setSettingsAttempt] = useState(0),
    [catalogAttempt, setCatalogAttempt] = useState(0);
  const [error, setError] = useState(""),
    [catalogError, setCatalogError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    let active = true;
    setError("");
    api<Settings>(`/reviews/${reviewId}/agent`)
      .then((value) => {
        if (active) {
          setSettings(value);
          setBackend(value.backend);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [reviewId, settingsAttempt]);
  useEffect(() => {
    if (!backend) return;
    let active = true;
    setCatalogError("");
    setCatalog(undefined);
    api<{ models: AgentModel[] }>(`/agents/${backend}/models`)
      .then((value) => {
        if (active) setCatalog({ backend, models: value.models });
      })
      .catch((e) => {
        if (active) setCatalogError(e.message);
      });
    return () => {
      active = false;
    };
  }, [backend, catalogAttempt]);
  const models = catalog && catalog.backend === backend ? catalog.models : [];
  const profile = backend
    ? profiles[backend] || settings?.profiles[backend] || {}
    : {};
  const model = profile.model
    ? models.find((m) => m.model === profile.model || m.id === profile.model)
    : models.find((m) => m.isDefault) || models[0];
  const effort = profile.effort || "";
  const valid =
    !!model && (!effort || model.efforts.some((e) => e.effort === effort));
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !submitting) onClose();
        }}
      >
        <header>
          <h2 id="generation-title">{regenerate ? "重新讲解" : "生成讲解"}</h2>
          <button
            className="quiet"
            disabled={submitting}
            onClick={onClose}
            aria-label="关闭生成设置"
          >
            ×
          </button>
        </header>
        <p className="muted">为这次讲解选择 Agent、模型和 thinking effort。</p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {settings && backend ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!valid || submitting) return;
              setSubmitting(true);
              setError("");
              try {
                const run = await api<Run>(
                  `/reviews/${reviewId}/analyze`,
                  "POST",
                  { backend, model: model.model, effort: effort || null },
                );
                onStarted(run);
              } catch (e: any) {
                setError(e.message);
                setSubmitting(false);
              }
            }}
          >
            <label>
              Agent
              <select
                autoFocus
                aria-label="本次讲解 Agent"
                disabled={submitting}
                value={backend}
                onChange={(e) => {
                  setBackend(e.target.value as Backend);
                  setError("");
                }}
              >
                <option value="traex">TraeX</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label>
              模型
              <select
                aria-label="本次讲解模型"
                disabled={submitting || !models.length}
                value={model?.model || profile.model || ""}
                onChange={(e) => {
                  setProfiles((current) => ({
                    ...current,
                    [backend]: { model: e.target.value, effort: "" },
                  }));
                  setError("");
                }}
              >
                {!models.length ? (
                  <option value={profile.model || ""}>正在读取模型…</option>
                ) : null}
                {profile.model && !model && models.length ? (
                  <option value={profile.model}>
                    {profile.model}（当前不可用）
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
                aria-label="本次讲解 thinking effort"
                disabled={submitting || !model}
                value={effort}
                onChange={(e) => {
                  setProfiles((current) => ({
                    ...current,
                    [backend]: { model: model!.model, effort: e.target.value },
                  }));
                  setError("");
                }}
              >
                <option value="">
                  模型默认
                  {model?.defaultEffort ? ` · ${model.defaultEffort}` : ""}
                </option>
                {effort && !model?.efforts.some((e) => e.effort === effort) ? (
                  <option value={effort}>{effort}（当前不可用）</option>
                ) : null}
                {model?.efforts.map((e) => (
                  <option key={e.effort} value={e.effort}>
                    {e.effort}
                  </option>
                ))}
              </select>
            </label>
            {catalogError ? (
              <p className="error" role="alert">
                模型读取失败：{catalogError}
              </p>
            ) : null}
            {catalogError || (catalog && !models.length) ? (
              <button
                type="button"
                className="text-button"
                onClick={() => setCatalogAttempt((n) => n + 1)}
              >
                重新读取模型
              </button>
            ) : null}
            <p className="hint">
              初始值来自当前 MR
              的配置。这些选择只用于本次讲解；更换模型后可重新选择 effort。
            </p>
            <footer>
              <button
                type="button"
                disabled={submitting}
                className="quiet"
                onClick={onClose}
              >
                取消
              </button>
              <button className="primary" disabled={!valid || submitting}>
                {submitting ? "正在启动…" : "开始讲解"}
              </button>
            </footer>
          </form>
        ) : error ? (
          <button
            className="text-button"
            onClick={() => setSettingsAttempt((n) => n + 1)}
          >
            重新读取设置
          </button>
        ) : (
          <p className="hint">正在读取 MR 的 Agent 配置…</p>
        )}
      </section>
    </div>
  );
}
