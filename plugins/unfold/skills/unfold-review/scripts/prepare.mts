#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export interface PrepareOptions {
  url: string;
  head: string;
  cli?: string;
  server?: string;
  tokenFile?: string;
  backend?: string;
  model?: string;
  effort?: string;
  resume?: string;
  regenerate?: boolean;
  clientConfig?: string;
}
type Invoke = (args: string[]) => Promise<any>;
type Progress = (event: Record<string, unknown>) => void;
export class PrepareError extends Error {
  code: string;
  details: unknown;
  exit: number;
  constructor(code: string, message: string, exit = 1, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
    this.exit = exit;
  }
}

export function clientConfigPath(
  options: PrepareOptions,
  env = process.env,
  home = os.homedir(),
) {
  return path.resolve(
    options.clientConfig ||
      env.UNFOLD_CLIENT_CONFIG ||
      path.join(
        env.XDG_CONFIG_HOME || path.join(home, ".config"),
        "unfold",
        "client.json",
      ),
  );
}

export function resolveClientOptions(
  options: PrepareOptions,
  env = process.env,
  home = os.homedir(),
): PrepareOptions {
  const file = clientConfigPath(options, env, home);
  let saved: Record<string, string> = {};
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (
      value?.version !== 1 ||
      !["server", "tokenFile", "cli"].every(
        (key) =>
          value[key] === undefined ||
          (typeof value[key] === "string" && value[key].trim()),
      ) ||
      Object.keys(value).some(
        (key) => !["version", "server", "tokenFile", "cli"].includes(key),
      )
    )
      throw Error("Expected version 1 and server/tokenFile/cli references");
    if (
      (value.tokenFile && !path.isAbsolute(value.tokenFile)) ||
      (value.cli &&
        /[/\\]|\.[cm]?[jt]s$/.test(value.cli) &&
        !path.isAbsolute(value.cli))
    )
      throw Error("Stored filesystem references must be absolute");
    saved = value;
  } catch (error: any) {
    if (error.code !== "ENOENT")
      throw new PrepareError(
        "invalid_client_config",
        "Cannot read the private Unfold client binding",
        2,
        { clientConfig: file, reason: error.message },
      );
  }
  const legacyRoot = path.resolve(env.UNFOLD_HOME || ".local");
  const legacyFile = path.join(legacyRoot, "config.json");
  let server = options.server || env.UNFOLD_SERVER || saved.server;
  let tokenFile = options.tokenFile || env.UNFOLD_TOKEN_FILE || saved.tokenFile;
  if (!server && existsSync(legacyFile)) {
    try {
      server = JSON.parse(readFileSync(legacyFile, "utf8")).ownerBaseUrl;
    } catch {
      throw new PrepareError(
        "invalid_client_config",
        "Cannot read the existing Unfold home configuration",
        2,
      );
    }
  }
  if (!tokenFile && existsSync(path.join(legacyRoot, "owner-token")))
    tokenFile = path.join(legacyRoot, "owner-token");
  if (!server || !tokenFile)
    throw new PrepareError(
      "client_not_configured",
      "Run prepare.mts configure --server OWNER_API_URL --token-file PRIVATE_KEY_FILE [--cli UNFOLD_EXECUTABLE] once on this machine",
      2,
      { clientConfig: file },
    );
  let address: URL;
  try {
    address = new URL(server);
  } catch {
    throw new PrepareError(
      "invalid_client_config",
      "Owner API address must be a full HTTP(S) URL",
      2,
    );
  }
  if (
    !/^https?:$/.test(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash
  )
    throw new PrepareError(
      "invalid_client_config",
      "Owner API address must not contain credentials, query parameters or fragments",
      2,
    );
  const cli = options.cli || env.UNFOLD_CLI || saved.cli || "unfold";
  return {
    ...options,
    clientConfig: file,
    server: address.href.replace(/\/$/, ""),
    tokenFile: path.resolve(tokenFile),
    cli: /[/\\]|\.[cm]?[jt]s$/.test(cli) ? path.resolve(cli) : cli,
  };
}

export async function checkClient(
  options: PrepareOptions,
  invoke = cliInvoker(options),
) {
  if (!Array.isArray(await invoke(["list"])))
    throw new PrepareError(
      "invalid_response",
      "Owner API did not return the authenticated review list",
    );
  return {
    configured: true,
    authenticated: true,
    clientConfig: options.clientConfig,
    server: options.server,
    cli: options.cli,
    tokenFile: options.tokenFile,
  };
}

export async function configureClient(
  options: PrepareOptions,
  invoke = cliInvoker(options),
) {
  let token: ReturnType<typeof statSync>;
  try {
    token = statSync(options.tokenFile!);
  } catch {
    throw new PrepareError(
      "authentication_required",
      "The existing owner key file is unavailable",
      6,
    );
  }
  if (!token.isFile() || !token.size || token.mode & 0o077)
    throw new PrepareError(
      "authentication_required",
      "Use a nonempty protected owner key file (mode 0600)",
      6,
    );
  const result = await checkClient(options, invoke);
  const file = options.clientConfig!;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify(
        {
          version: 1,
          server: options.server,
          tokenFile: options.tokenFile,
          cli: options.cli,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ...result, saved: true };
}

const execute = promisify(execFile);
export function cliInvoker(options: PrepareOptions): Invoke {
  const executable = options.cli || process.env.UNFOLD_CLI || "unfold";
  const prefix = ["--json"];
  if (options.server) prefix.push("--server", options.server);
  if (options.tokenFile) prefix.push("--token-file", options.tokenFile);
  return async (args) => {
    const script = /\.[cm]?[jt]s$/.test(executable);
    let result: { stdout: string; stderr: string },
      exit = 0;
    try {
      result = await execute(
        script ? process.execPath : executable,
        [...(script ? [executable] : []), ...prefix, ...args],
        { maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (error: any) {
      result = { stdout: error.stdout || "", stderr: error.stderr || "" };
      exit = typeof error.code === "number" ? error.code : 1;
      if (error.code === "ENOENT")
        throw new PrepareError(
          "cli_missing",
          "Set UNFOLD_CLI or --cli to the installed Unfold executable",
          2,
        );
    }
    let envelope: any;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {}
    if (
      envelope?.ok &&
      (!exit ||
        (["analyze", "watch"].includes(args[0]) && envelope.data?.state))
    )
      return envelope.data;
    let failure: any;
    for (const line of result.stderr.trim().split("\n").reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) {
          failure = parsed.error;
          break;
        }
      } catch {}
    }
    throw new PrepareError(
      failure?.code || "cli_failed",
      failure?.message ||
        "Unfold CLI failed; recover any accepted run before retrying",
      exit || 1,
      failure?.details,
    );
  };
}

function shareEntry(value: unknown, reviewId: string, explanationId?: string) {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new PrepareError(
      "invalid_share_url",
      "Unfold did not return a valid share URL",
      2,
    );
  }
  const host = url.hostname;
  const suffix = `/r/${reviewId}${explanationId ? `/v/${explanationId}` : ""}`;
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    host.endsWith(".ts.net") ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^\[fd7a:115c:a1e0:/i.test(host) ||
    !url.pathname.endsWith(suffix)
  )
    throw new PrepareError(
      "invalid_share_url",
      "Use the configured company read-only entry; keep owner, localhost and Tailscale URLs private",
      2,
    );
  return {
    url: url.href,
    base: url.origin + url.pathname.slice(0, -suffix.length),
  };
}

export async function prepareReview(
  options: PrepareOptions,
  invoke: Invoke = cliInvoker(options),
  visitorFetch: typeof fetch = fetch,
  progress: Progress = () => {},
) {
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(options.head || ""))
    throw new PrepareError(
      "invalid_input",
      "--head must be the full commit actually submitted to the MR/PR",
      2,
    );
  if (options.backend && !["codex", "traex"].includes(options.backend))
    throw new PrepareError(
      "invalid_input",
      "--backend must be codex or traex",
      2,
    );
  const expectedHead = options.head.toLowerCase();
  const review = await invoke(["import", options.url]);
  const reviewId: string = review.id;
  if (!reviewId)
    throw new PrepareError("invalid_response", "Import returned no review ID");
  const currentVersion = async (bundle: any) => {
    const versionId = bundle.review.versionId;
    if (bundle.version?.id === versionId) return bundle.version;
    const versions = await invoke(["versions", reviewId]);
    const version = versions.find((v: any) => v.id === versionId);
    if (!version)
      throw new PrepareError(
        "invalid_response",
        "Latest immutable version is missing",
      );
    return version;
  };
  const initial = await invoke(["refresh", reviewId]);
  const version = await currentVersion(initial);
  const context = { reviewId, versionId: version.id, expectedHead };
  let runId: string | undefined;
  const call: Invoke = async (args) => {
    try {
      return await invoke(args);
    } catch (error) {
      if (error instanceof PrepareError)
        error.details = { ...context, runId, cause: error.details };
      throw error;
    }
  };
  if (version.head !== expectedHead)
    throw new PrepareError(
      "revision_conflict",
      "Remote head differs from the submitted commit; prepare the intended revision explicitly",
      4,
      { ...context, remoteHead: version.head },
    );

  const visitor = async (url: string) => {
    try {
      const response = await visitorFetch(url, {
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as any;
    } catch (error: any) {
      throw new PrepareError(
        "share_unreachable",
        "Could not verify the company read-only entry without owner credentials",
        1,
        { ...context, reason: error.message },
      );
    }
  };
  const checkViewer = async (base: string) => {
    const health = await visitor(base + "/healthz");
    if (health.status !== "ok" || health.mode !== "viewer")
      throw new PrepareError(
        "invalid_share_listener",
        "The share entry must serve the read-only viewer",
        2,
        context,
      );
  };
  const preflight = shareEntry((await call(["share", reviewId])).url, reviewId);
  await checkViewer(preflight.base);
  const matchesProfile = (value: any) =>
    ["backend", "model", "effort"].every(
      (key) =>
        !options[key as keyof PrepareOptions] ||
        value?.[key] === options[key as keyof PrepareOptions],
    );
  const reusable =
    initial.explanation?.versionId === version.id &&
    initial.explanation.guide?.groups?.length &&
    matchesProfile(initial.explanation);
  let explanation =
    reusable && !options.regenerate && !options.resume
      ? initial.explanation
      : undefined;
  if (!explanation) {
    let run = options.resume
      ? await call(["run", options.resume])
      : (await call(["runs", reviewId])).find(
          (r: any) =>
            r.kind === "analysis" &&
            r.versionId === version.id &&
            ["running", "awaiting_approval"].includes(r.state) &&
            matchesProfile(r),
        );
    if (!run) {
      const args = ["analyze", reviewId];
      for (const key of ["backend", "model", "effort"] as const)
        if (options[key]) args.push(`--${key}`, options[key]);
      run = await call(args);
    }
    runId = run.id;
    if (
      !runId ||
      run.reviewId !== reviewId ||
      run.kind !== "analysis" ||
      run.versionId !== version.id ||
      !matchesProfile(run)
    )
      throw new PrepareError(
        "run_conflict",
        "The run does not analyze this submitted revision and requested profile",
        4,
        { ...context, runId },
      );
    progress({ event: "analysis", ...context, runId, state: run.state });
    if (run.state === "running") run = await call(["watch", runId]);
    if (
      run.id !== runId ||
      run.reviewId !== reviewId ||
      run.kind !== "analysis" ||
      run.versionId !== version.id ||
      !matchesProfile(run)
    )
      throw new PrepareError(
        "run_conflict",
        "Observed run identity or revision changed",
        4,
        { ...context, runId },
      );
    if (run.state !== "succeeded")
      throw new PrepareError(
        run.state === "awaiting_approval"
          ? "confirmation_required"
          : "analysis_failed",
        run.state === "awaiting_approval"
          ? "Exact execution approval is pending; use --resume after a decision"
          : "Analysis did not succeed; the previous explanation is not this run's result",
        run.state === "awaiting_approval" ? 3 : 1,
        { ...context, runId, state: run.state, error: run.error },
      );
    if (!run.explanationId)
      throw new PrepareError(
        "invalid_response",
        "Successful analysis returned no explanation ID",
        1,
        { ...context, runId },
      );
    explanation = (
      await call(["show", reviewId, "--explanation", run.explanationId])
    ).explanation;
  }
  if (
    !explanation?.id ||
    explanation.reviewId !== reviewId ||
    explanation.versionId !== version.id ||
    !explanation.guide?.groups?.length
  )
    throw new PrepareError(
      "invalid_explanation",
      "A version-bound explanation and change guide are required",
      1,
      { ...context, runId },
    );
  const finalVersion = await currentVersion(await call(["refresh", reviewId]));
  if (
    finalVersion.id !== version.id ||
    finalVersion.head !== expectedHead ||
    finalVersion.base !== version.base
  )
    throw new PrepareError(
      "revision_conflict",
      "The MR changed while preparing its explanation; no ready-to-send URL was produced",
      4,
      {
        ...context,
        runId,
        explanationId: explanation.id,
        remoteHead: finalVersion.head,
      },
    );
  const entry = shareEntry(
    (await call(["share", reviewId, "--explanation", explanation.id])).url,
    reviewId,
    explanation.id,
  );
  if (entry.base !== preflight.base) await checkViewer(entry.base);
  const publicResult = await visitor(
    `${entry.base}/api/v1/reviews/${encodeURIComponent(reviewId)}?explanationId=${encodeURIComponent(explanation.id)}`,
  );
  if (
    !publicResult.ok ||
    publicResult.data?.explanation?.id !== explanation.id ||
    publicResult.data?.explanation?.versionId !== version.id ||
    publicResult.data?.version?.head !== expectedHead ||
    publicResult.data?.version?.base !== version.base
  )
    throw new PrepareError(
      "share_not_ready",
      "The visitor entry did not return this exact explanation and revision",
      1,
      { ...context, runId },
    );
  const title = String(explanation.title)
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .replace(/@/g, "＠")
    .slice(0, 200);
  return {
    status: "ready",
    reviewId,
    runId,
    explanationId: explanation.id,
    versionId: version.id,
    head: expectedHead,
    base: version.base,
    sourceUrl: review.target.url,
    url: entry.url,
    title,
    summary: explanation.summary,
    reused: !runId,
    message: `改动讲解已准备好：${title}\nMR/PR：${review.target.url}\n对应提交：${expectedHead}\n只读讲解：${entry.url}`,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      head: { type: "string" },
      cli: { type: "string" },
      server: { type: "string" },
      "token-file": { type: "string" },
      "client-config": { type: "string" },
      backend: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      resume: { type: "string" },
      regenerate: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node prepare.mts configure --server OWNER_API_URL --token-file PRIVATE_KEY_FILE [--cli PATH]\n       node prepare.mts check [--client-config FILE]\n       node prepare.mts MR_URL --head FULL_SUBMITTED_COMMIT [--cli PATH] [--server URL] [--token-file PATH] [--client-config FILE] [--backend codex|traex] [--model MODEL] [--effort EFFORT] [--resume RUN] [--regenerate]\nReturns one JSON result; progress and failures go to stderr. Requires Node.js 24+. Configuration precedence: explicit options, UNFOLD_* environment, private client binding, existing Unfold home.",
    );
    return;
  }
  if (positionals.length !== 1)
    throw new PrepareError(
      "invalid_input",
      "Provide one submitted MR/PR URL; use --help for options",
      2,
    );
  const input: PrepareOptions = {
    ...values,
    url: positionals[0],
    head: values.head || "",
    tokenFile: values["token-file"],
    clientConfig: values["client-config"],
  };
  if (["configure", "check"].includes(input.url)) {
    const resolved = resolveClientOptions(input);
    const result =
      input.url === "configure"
        ? await configureClient(resolved)
        : await checkClient(resolved);
    console.log(JSON.stringify({ ok: true, data: result }));
    return;
  }
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(input.head))
    throw new PrepareError(
      "invalid_input",
      "--head must be the full submitted commit",
      2,
    );
  const result = await prepareReview(
    resolveClientOptions(input),
    undefined,
    undefined,
    (event) => process.stderr.write(JSON.stringify(event) + "\n"),
  );
  console.log(JSON.stringify({ ok: true, data: result }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: {
          code: error.code?.startsWith("ERR_PARSE_ARGS")
            ? "invalid_input"
            : error.code || "operation_failed",
          message: error.message,
          details: error.details,
        },
      }),
    );
    process.exitCode =
      error.exit || (error.code?.startsWith("ERR_PARSE_ARGS") ? 2 : 1);
  });
