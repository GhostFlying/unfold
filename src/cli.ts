#!/usr/bin/env node
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import {
  loadConfig,
  saveConfig,
  localRoot,
  secret,
  shareUrl,
} from "./config.js";
import { startConnector } from "./connector.js";
import { startServers } from "./server.js";
import { AppError, type Run } from "./types.js";

const program = new Command()
  .name("unfold")
  .description("Investigate a change and review it deliberately")
  .version("0.1.0")
  .enablePositionalOptions()
  .exitOverride()
  .configureOutput({
    writeErr: (text) => {
      if (!process.argv.includes("--json")) process.stderr.write(text);
    },
  })
  .option("--json", "Machine-readable output")
  .option("--server <url>", "Owner API URL")
  .option("--token-file <path>", "Owner key file");
function out(data: unknown) {
  console.log(
    JSON.stringify(
      { ok: true, data },
      null,
      program.opts().json ? undefined : 2,
    ),
  );
}
async function api<T = any>(
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const cfg = loadConfig();
  const token = await readFile(
    program.opts().tokenFile || path.join(localRoot(), "owner-token"),
    "utf8",
  ).catch(() => "");
  const response = await fetch(
    `${program.opts().server || cfg.ownerBaseUrl}/api/v1${endpoint}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token.trim()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const result = (await response.json()) as any;
  if (!result.ok)
    throw new AppError(
      result.error?.code || "request_failed",
      result.error?.message || `HTTP ${response.status}`,
      response.status,
      result.error?.details,
    );
  return result.data;
}
const wrap =
  (fn: (...args: any[]) => unknown) =>
  async (...args: any[]): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  };
function fail(error: any) {
  if (
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version"
  )
    return;
  const code =
    error instanceof z.ZodError || error.code?.startsWith("commander.")
      ? "invalid_input"
      : error.code || "operation_failed";
  const exit =
    code === "confirmation_required"
      ? 3
      : code.includes("auth")
        ? 6
        : code.includes("unknown")
          ? 5
          : error.status === 409
            ? 4
            : [
                  "invalid_input",
                  "invalid_config",
                  "unsupported_model",
                  "unsupported_effort",
                ].includes(code)
              ? 2
              : 1;
  console.error(
    JSON.stringify({
      ok: false,
      error: { code, message: error.message, details: error.details },
    }),
  );
  process.exitCode = exit;
}
async function textInput(options: any) {
  if (options.body !== undefined) return options.body;
  if (options.bodyFile) {
    if (options.bodyFile === "-") {
      let body = "";
      for await (const chunk of process.stdin) body += chunk;
      return body;
    }
    return readFile(options.bodyFile, "utf8");
  }
  throw new AppError(
    "invalid_input",
    "Provide --body or --body-file (use - for stdin)",
  );
}
async function wait(runId: string) {
  let run = await api<Run>(`/runs/${runId}`);
  const terminal = () => !["running"].includes(run.state);
  if (terminal()) return finishRun(run);
  const cfg = loadConfig(),
    token = await readFile(
      program.opts().tokenFile || path.join(localRoot(), "owner-token"),
      "utf8",
    );
  const response = await fetch(
    `${program.opts().server || cfg.ownerBaseUrl}/api/v1/runs/${runId}/events`,
    { headers: { authorization: `Bearer ${token.trim()}` } },
  );
  if (!response.ok || !response.body)
    throw new AppError(
      "event_stream_failed",
      "Could not open event stream",
      502,
    );
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (!program.opts().json && event.message) console.error(event.message);
        if (!program.opts().json && event.type === "usage")
          console.error(
            `本次 token：${event.usage.totalTokens.toLocaleString("en-US")} · 输入 ${event.usage.inputTokens.toLocaleString("en-US")}（缓存 ${event.usage.cachedInputTokens.toLocaleString("en-US")}）· 输出 ${event.usage.outputTokens.toLocaleString("en-US")}（推理 ${event.usage.reasoningOutputTokens.toLocaleString("en-US")}）`,
          );
        if (event.type === "finished" || event.type === "approval") {
          run = await api(`/runs/${runId}`);
          if (terminal()) return finishRun(run);
        }
      }
    }
    return finishRun(await api(`/runs/${runId}`));
  } finally {
    await reader.cancel();
  }
}
function finishRun(run: Run) {
  out(run);
  if (run.state === "awaiting_approval") process.exitCode = 3;
  else if (run.state !== "succeeded") process.exitCode = 1;
  return run;
}
function runEffort(options: any) {
  if (options.modelDefaultEffort && options.effort)
    throw new AppError(
      "invalid_input",
      "Choose --effort or --model-default-effort",
    );
  return options.modelDefaultEffort ? null : options.effort;
}

program
  .command("init")
  .description("Create ignored local configuration and owner/connector keys")
  .option("--codebase-host <host>", "Allow one company Codebase host")
  .option("--share-base-url <url>", "Company-network share URL")
  .option("--share-bind <address>", "Address for the read-only listener")
  .action(
    wrap((opts) => {
      const cfg = loadConfig();
      if (opts.codebaseHost)
        cfg.codebaseHosts = [
          z
            .string()
            .regex(/^[a-zA-Z0-9.-]+$/)
            .parse(opts.codebaseHost),
        ];
      if (opts.shareBind) cfg.shareBind = opts.shareBind;
      if (opts.shareBaseUrl) {
        cfg.shareBaseUrl = opts.shareBaseUrl;
        shareUrl(cfg, "configuration-check");
      }
      saveConfig(cfg);
      secret(localRoot(), "owner-token");
      secret(localRoot(), "connector-token");
      out({
        configFile: path.join(localRoot(), "config.json"),
        next: ["unfold connector", "unfold serve"],
        ownerUrl: cfg.ownerBaseUrl,
      });
    }),
  );
program
  .command("serve")
  .description("Start separate owner and read-only HTTP listeners")
  .action(
    wrap(async () => {
      const servers = await startServers(loadConfig());
      out({
        owner: loadConfig().ownerBaseUrl,
        shareListener: `${loadConfig().shareBind}:${loadConfig().sharePort}`,
      });
      const stop = async () => {
        await servers.close();
        process.exit(0);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }),
  );
program
  .command("connector")
  .description("Start the authenticated native Unix-socket connector")
  .action(
    wrap(async () => {
      const app = await startConnector(loadConfig());
      out({ socket: loadConfig().socketPath });
      const stop = async () => {
        await app.close();
        process.exit(0);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    }),
  );
program.command("doctor").action(wrap(async () => out(await api("/doctor"))));
const auth = program.command("auth");
auth
  .command("token")
  .description("Print the local owner key deliberately; keep it private")
  .action(
    wrap(async () =>
      out({
        token: await readFile(path.join(localRoot(), "owner-token"), "utf8"),
      }),
    ),
  );
function configurationResult(result: any) {
  out(result);
  if (["failed", "unavailable"].includes((result.application || result).state))
    process.exitCode = 7;
}
const config = program.command("config");
config.command("show").action(wrap(async () => out(await api("/config"))));
config
  .command("status")
  .description("Inspect automatic application of saved settings")
  .action(wrap(async () => configurationResult(await api("/config/status"))));
config
  .command("apply")
  .description("Retry applying saved settings without restarting active work")
  .action(
    wrap(async () =>
      configurationResult(await api("/config/apply", "POST", {})),
    ),
  );
config
  .command("set <key> <json-value>")
  .description("Set a shared setting; JSON strings must be quoted")
  .action(
    wrap(async (key, value) => {
      if (
        ![
          "defaultBackend",
          "shareBaseUrl",
          "ownerBaseUrl",
          "codebaseHosts",
          "agents",
        ].includes(key)
      )
        throw new AppError("invalid_input", "Unsupported configuration key");
      configurationResult(
        await api("/config", "PATCH", { [key]: JSON.parse(value) }),
      );
    }),
  );
const agent = program
  .command("agent")
  .description("Configure backend, model and thinking effort");
agent
  .command("models <backend>")
  .action(wrap(async (backend) => out(await api(`/agents/${backend}/models`))));
agent
  .command("show <review>")
  .action(wrap(async (review) => out(await api(`/reviews/${review}/agent`))));
agent
  .command("defaults <backend>")
  .option("--model <model>")
  .option("--effort <effort>")
  .option("--reset", "Use native model defaults and advertised default effort")
  .action(
    wrap(async (backend, o) => {
      const cfg = await api("/config");
      if (!["traex", "codex"].includes(backend))
        throw new AppError("invalid_input", "Expected traex or codex");
      const settings = { ...cfg.agents[backend] };
      if (o.reset) {
        delete settings.model;
        delete settings.effort;
      }
      if (o.model) settings.model = o.model;
      if (o.effort) settings.effort = o.effort;
      configurationResult(
        await api("/config", "PATCH", { agents: { [backend]: settings } }),
      );
    }),
  );
agent
  .command("set <review>")
  .requiredOption("--backend <backend>")
  .option("--model <model>")
  .option("--effort <effort>")
  .option("--inherit-model")
  .option("--inherit-effort")
  .option(
    "--model-default-effort",
    "Use this model's default effort for this MR",
  )
  .action(
    wrap(async (review, o) => {
      if (o.modelDefaultEffort && (o.effort || o.inheritEffort))
        throw new AppError(
          "invalid_input",
          "Choose --effort, --inherit-effort or --model-default-effort",
        );
      out(
        await api(`/reviews/${review}`, "PATCH", {
          backend: o.backend,
          agentOverrides: {
            [o.backend]: {
              model: o.inheritModel ? null : o.model,
              effort: o.inheritEffort ? null : o.effort,
              modelDefaultEffort: o.modelDefaultEffort || undefined,
            },
          },
        }),
      );
    }),
  );
program
  .command("import <url>")
  .option("--backend <backend>", "traex or codex")
  .action(
    wrap(async (url, o) =>
      out(await api("/reviews", "POST", { url, backend: o.backend })),
    ),
  );
program.command("list").action(wrap(async () => out(await api("/reviews"))));
program
  .command("show <review>")
  .option("--explanation <id>")
  .action(
    wrap(async (review, o) =>
      out(
        await api(
          `/reviews/${review}${o.explanation ? `?explanationId=${o.explanation}` : ""}`,
        ),
      ),
    ),
  );
program
  .command("refresh <review>")
  .action(
    wrap(async (review) =>
      out(await api(`/reviews/${review}/refresh`, "POST", {})),
    ),
  );
program
  .command("guide <review>")
  .description("Read logical change groups or one change point")
  .option("--explanation <id>")
  .option("--point <id>")
  .action(
    wrap(async (review, o) => {
      const query = new URLSearchParams();
      if (o.explanation) query.set("explanationId", o.explanation);
      if (o.point) query.set("point", o.point);
      out(await api(`/reviews/${review}/guide?${query}`));
    }),
  );
program.command("backend <review> <backend>").action(
  wrap(async (review, backend) =>
    out(
      await api(`/reviews/${review}`, "PATCH", {
        backend: backend === "inherit" ? null : backend,
      }),
    ),
  ),
);
program
  .command("analyze <review>")
  .option("--backend <backend>")
  .option("--model <model>")
  .option("--effort <effort>")
  .option(
    "--model-default-effort",
    "Use this model's advertised default effort",
  )
  .option("--wait", "Wait for completion or exact approval request")
  .action(
    wrap(async (review, o) => {
      const run = await api(`/reviews/${review}/analyze`, "POST", {
        backend: o.backend,
        model: o.model,
        effort: runEffort(o),
      });
      if (o.wait) await wait(run.id);
      else out(run);
    }),
  );
program
  .command("ask <review>")
  .option("--body <text>")
  .option("--body-file <path>")
  .option("--reference <id>")
  .option("--explanation <id>")
  .option("--backend <backend>")
  .option("--model <model>")
  .option("--effort <effort>")
  .option(
    "--model-default-effort",
    "Use this model's advertised default effort",
  )
  .option("--wait")
  .action(
    wrap(async (review, o) => {
      const run = await api(`/reviews/${review}/questions`, "POST", {
        question: await textInput(o),
        referenceId: o.reference,
        explanationId: o.explanation,
        backend: o.backend,
        model: o.model,
        effort: runEffort(o),
      });
      if (o.wait) await wait(run.id);
      else out(run);
    }),
  );
program
  .command("runs <review>")
  .action(wrap(async (review) => out(await api(`/reviews/${review}/runs`))));
program.command("watch <run>").action(wrap(async (run) => wait(run)));
program
  .command("artifact <run>")
  .description(
    "Inspect privately saved explanation parts, including failed/interrupted runs",
  )
  .option(
    "--content",
    "Include saved part content; incomplete HTML is not published",
  )
  .action(
    wrap(async (run, options) =>
      out(
        await api(
          `/runs/${run}/artifact${options.content ? "?content=1" : ""}`,
        ),
      ),
    ),
  );
program
  .command("run <run>")
  .description("Read a persisted run, progress and per-run token usage")
  .action(wrap(async (run) => out(await api(`/runs/${run}`))));
program
  .command("cancel <run>")
  .action(
    wrap(async (run) => out(await api(`/runs/${run}/cancel`, "POST", {}))),
  );
program
  .command("history <review>")
  .action(wrap(async (review) => out(await api(`/reviews/${review}/history`))));
program
  .command("versions <review>")
  .action(
    wrap(async (review) => out(await api(`/reviews/${review}/versions`))),
  );
program
  .command("diff <review>")
  .option("--version <id>")
  .option("--path <path>")
  .action(
    wrap(async (review, o) => {
      const snapshot = await api(
        `/reviews/${review}/snapshot${o.version ? `?versionId=${encodeURIComponent(o.version)}` : ""}`,
      );
      let files = snapshot.files;
      if (o.path)
        files = files.filter(
          (f: any) => f.path === o.path || f.oldPath === o.path,
        );
      out(files);
    }),
  );
program
  .command("source <review> <path>")
  .requiredOption("--version <id>")
  .option("--side <side>", "old or new", "new")
  .action(
    wrap(async (review, file, o) =>
      out(
        await api(
          `/reviews/${review}/source?${new URLSearchParams({ versionId: o.version, path: file, side: o.side })}`,
        ),
      ),
    ),
  );
program
  .command("reference <review> <path>")
  .requiredOption("--version <id>")
  .requiredOption("--start <line>")
  .option("--end <line>")
  .option("--side <side>", "old or new", "new")
  .action(
    wrap(async (review, file, o) =>
      out(
        await api(`/reviews/${review}/references`, "POST", {
          versionId: o.version,
          path: file,
          side: o.side,
          start: +o.start,
          end: +(o.end || o.start),
        }),
      ),
    ),
  );
program
  .command("share <review>")
  .option("--explanation <id>")
  .action(
    wrap(async (review, o) =>
      out(
        await api(
          `/reviews/${review}/share${o.explanation ? `?explanationId=${o.explanation}` : ""}`,
        ),
      ),
    ),
  );
program
  .command("export <review>")
  .requiredOption("--output <file>")
  .option("--explanation <id>")
  .action(
    wrap(async (review, o) => {
      const b = await api(
        `/reviews/${review}${o.explanation ? `?explanationId=${o.explanation}` : ""}`,
      );
      if (!b.explanation)
        throw new AppError("not_found", "No explanation exists", 404);
      const { exportHtml } = await import("./html.js");
      await writeFile(
        o.output,
        exportHtml(b.explanation.title, b.explanation.html),
      );
      out({ file: path.resolve(o.output), explanationId: b.explanation.id });
    }),
  );
program
  .command("open <review>")
  .option("--explanation <id>")
  .action(
    wrap(async (review, o) => {
      const url = `${program.opts().server || loadConfig().ownerBaseUrl}/r/${review}${o.explanation ? `/v/${o.explanation}` : ""}`;
      const exe = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(exe, [url], { detached: true, stdio: "ignore" });
      child.on("error", fail);
      child.unref();
      out({ url });
    }),
  );
const draft = program.command("draft");
draft
  .command("list <review>")
  .action(wrap(async (review) => out(await api(`/reviews/${review}/drafts`))));
draft
  .command("show <id>")
  .action(wrap(async (id) => out(await api(`/drafts/${id}`))));
draft
  .command("create <review>")
  .option("--body <text>")
  .option("--body-file <file>")
  .option("--reference <id>")
  .option("--version <id>")
  .action(
    wrap(async (review, o) =>
      out(
        await api(`/reviews/${review}/drafts`, "POST", {
          body: await textInput(o),
          referenceId: o.reference,
          versionId: o.version,
        }),
      ),
    ),
  );
draft
  .command("edit <id>")
  .requiredOption("--revision <n>")
  .option("--body <text>")
  .option("--body-file <file>")
  .option(
    "--general",
    "Explicitly relocate to a current-version general comment",
  )
  .action(
    wrap(async (id, o) =>
      out(
        await api(`/drafts/${id}`, "PATCH", {
          body: await textInput(o),
          revision: +o.revision,
          general: !!o.general,
        }),
      ),
    ),
  );
draft
  .command("preview <id>")
  .action(
    wrap(async (id) => out(await api(`/drafts/${id}/preview`, "POST", {}))),
  );
draft
  .command("publish <id>")
  .option("--confirm <digest>", "Exact preview digest; no blanket --yes")
  .action(
    wrap(async (id, o) => {
      if (!o.confirm) {
        const preview = await api(`/drafts/${id}/preview`, "POST", {});
        throw new AppError(
          "confirmation_required",
          "Review this preview and provide --confirm with its digest",
          409,
          preview,
        );
      }
      const d = await api(`/drafts/${id}/publish`, "POST", {
        confirm: o.confirm,
      });
      out(d);
      if (d.state === "unknown") process.exitCode = 5;
    }),
  );
draft.command("reconcile <id>").action(
  wrap(async (id) => {
    const d = await api(`/drafts/${id}/reconcile`, "POST", {});
    out(d);
    if (d.state === "unknown") process.exitCode = 5;
  }),
);
const approval = program.command("approval");
approval.command("list").action(wrap(async () => out(await api("/approvals"))));
for (const [name, approve] of [
  ["approve", true],
  ["deny", false],
] as const)
  approval
    .command(`${name} <id>`)
    .requiredOption("--confirm <digest>")
    .action(
      wrap(async (id, o) =>
        out(
          await api(`/approvals/${id}/decision`, "POST", {
            approve,
            confirm: o.confirm,
          }),
        ),
      ),
    );

program.parseAsync().catch(fail);
