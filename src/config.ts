import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  realpathSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { hash } from "./util.js";
import { AppError, type Backend } from "./types.js";
export interface AgentConfig {
  executable: string;
  authFile: string;
  model?: string;
  effort?: string;
  provider?: string;
  providerConfig?: Record<string, unknown>;
}
export interface Config {
  dataDir: string;
  socketPath: string;
  ownerPort: number;
  sharePort: number;
  shareBind: string;
  shareBaseUrl: string;
  ownerBaseUrl: string;
  codebaseHosts: string[];
  defaultBackend: Backend;
  agents: Record<Backend, AgentConfig>;
}
export const localRoot = () =>
  path.resolve(process.env.UNFOLD_HOME || ".local");
export function secret(root: string, name: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const f = path.join(root, name);
  if (!existsSync(f))
    writeFileSync(f, randomBytes(32).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  chmodSync(f, 0o600);
  return readFileSync(f, "utf8").trim();
}
function nativeConfig(b: Backend): AgentConfig {
  const home = os.homedir();
  const native =
    b === "codex"
      ? path.join(home, ".codex/config.toml")
      : path.join(home, ".trae/traecli.toml");
  let cfg: Record<string, any> = {};
  if (existsSync(native)) cfg = parse(readFileSync(native, "utf8"));
  return {
    executable: b,
    authFile: path.join(
      home,
      b === "codex" ? ".codex/auth.json" : ".trae/cli/auth.json",
    ),
    model: cfg.model,
    effort: cfg.model_reasoning_effort,
    provider: cfg.model_provider,
    providerConfig: cfg.model_providers?.[cfg.model_provider],
  };
}
export function loadConfig(): Config {
  const root = localRoot();
  const defaults: Config = {
    dataDir: path.join(root, "data"),
    socketPath: path.join(root, "connector.sock"),
    ownerPort: 18371,
    sharePort: 18370,
    shareBind: "127.0.0.1",
    shareBaseUrl: "",
    ownerBaseUrl: "http://127.0.0.1:18371",
    codebaseHosts: [],
    defaultBackend: "traex",
    agents: { traex: nativeConfig("traex"), codex: nativeConfig("codex") },
  };
  const file = path.join(root, "config.json");
  const existing = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const c = {
    ...defaults,
    ...existing,
    agents: { ...defaults.agents, ...existing.agents },
  } as Config;
  if (process.env.UNFOLD_DATA_DIR) c.dataDir = process.env.UNFOLD_DATA_DIR;
  if (process.env.UNFOLD_CONNECTOR_SOCKET)
    c.socketPath = process.env.UNFOLD_CONNECTOR_SOCKET;
  if (process.env.UNFOLD_OWNER_PORT)
    c.ownerPort = +process.env.UNFOLD_OWNER_PORT;
  if (process.env.UNFOLD_SHARE_PORT)
    c.sharePort = +process.env.UNFOLD_SHARE_PORT;
  if (process.env.UNFOLD_SHARE_LISTEN)
    c.shareBind = process.env.UNFOLD_SHARE_LISTEN;
  if (!["traex", "codex"].includes(c.defaultBackend))
    throw new AppError(
      "invalid_config",
      "defaultBackend must be traex or codex",
    );
  return c;
}
export function saveConfig(config: Config) {
  mkdirSync(localRoot(), { recursive: true, mode: 0o700 });
  const file = path.join(localRoot(), "config.json");
  const previous = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {};
  const persisted = { ...config } as Record<string, unknown>;
  for (const [env, key] of Object.entries({
    UNFOLD_DATA_DIR: "dataDir",
    UNFOLD_CONNECTOR_SOCKET: "socketPath",
    UNFOLD_OWNER_PORT: "ownerPort",
    UNFOLD_SHARE_PORT: "sharePort",
    UNFOLD_SHARE_LISTEN: "shareBind",
  })) {
    if (process.env[env]) {
      if (previous[key] === undefined) delete persisted[key];
      else persisted[key] = previous[key];
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(persisted, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
}
export function shareUrl(
  config: Config,
  reviewId: string,
  explanationId?: string,
) {
  const s = config.shareBaseUrl;
  if (!s)
    throw new AppError(
      "share_not_configured",
      "Configure shareBaseUrl with a company-network URL",
      409,
    );
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AppError(
      "invalid_share_url",
      "shareBaseUrl must be an HTTP(S) URL",
    );
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    /^(localhost|127\.|\[?::1\]?$)/.test(u.hostname) ||
    u.hostname.endsWith(".ts.net") ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u.hostname) ||
    u.username ||
    u.password
  )
    throw new AppError(
      "invalid_share_url",
      "Share URLs must use the company-network entry, not localhost or Tailscale",
    );
  return `${s.replace(/\/$/, "")}/r/${reviewId}${explanationId ? `/v/${explanationId}` : ""}`;
}
export function installedCliRoot(executable = "bytedcli") {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, executable);
    if (existsSync(p)) return path.dirname(realpathSync(p));
  }
  throw new AppError("cli_missing", `${executable} is not installed`, 503);
}

export function settingsRevision(value: unknown): string {
  const sorted = (v: any): any =>
    Array.isArray(v)
      ? v.map(sorted)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .filter((k) => v[k] !== undefined)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  return hash(sorted(value));
}
