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
