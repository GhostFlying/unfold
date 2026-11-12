import Fastify from "fastify";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { rm } from "node:fs/promises";
import {
  type Config,
  loadConfig,
  localRoot,
  secret,
  settingsRevision,
} from "./config.js";
import { Providers } from "./providers.js";
import { AgentHost, type AgentParams } from "./agent.js";
import { AppError } from "./types.js";
import {
  ConnectorRuntime,
  backendConnectionRevision,
} from "./connector-runtime.js";
import { equal, command, id } from "./util.js";

export async function startConnector(config: Config) {
  const root = localRoot(),
    token = secret(root, "connector-token");
  const makeRuntime = (settings: Config) => {
    const config = structuredClone(settings);
    const providers = new Providers(config);
    return { config, providers, host: new AgentHost(config, root, providers) };
  };
  const runtime = new ConnectorRuntime(
    config,
    makeRuntime(config),
    async (next, previous) => {
      const candidate = makeRuntime(next);
      // Probe in a disposable home so failed readiness checks cannot modify the
      // persistent authentication link/configuration of the current runtime.
      const checkRoot = path.join(root, "connection-checks", id());
      try {
        const checker = new AgentHost(
          candidate.config,
          checkRoot,
          candidate.providers,
        );
        for (const backend of ["traex", "codex"] as const) {
          if (
            settingsRevision(next.agents[backend]) !==
            settingsRevision(previous.config.agents[backend])
          )
            await checker.catalog(
              backend,
              {
                model: next.agents[backend].model,
                effort: next.agents[backend].effort,
              },
              true,
            );
        }
        return candidate;
      } finally {
        await rm(checkRoot, { recursive: true, force: true });
      }
    },
  );
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  let active: { controller: AbortController; host: AgentHost } | undefined;
  app.addHook("onRequest", async (req) => {
    if (!equal(req.headers.authorization || "", `Bearer ${token}`))
      throw new AppError(
        "unauthorized",
        "Connector authentication required",
        401,
      );
  });
  app.setErrorHandler((e: any, _req, res) =>
    res.status(e.status || 400).send({
      ok: false,
      error: {
        code: e.code || "connector_error",
        message: e.message,
        details: e.details,
      },
    }),
  );
  app.post("/rpc", async (req) => {
    const { method, params: p } = req.body as { method: string; params: any };
    if (method === "reload_config")
      return { ok: true, data: await runtime.reload(loadConfig(), true) };
    if (method === "config_status") {
      void runtime.reload(loadConfig());
      return { ok: true, data: runtime.status() };
    }
    if (method === "approval")
      return {
        ok: true,
        data: (active?.host || runtime.value().host).decide(
          p.id,
          p.digest,
          p.approve,
        ),
      };
    if (method === "health")
      return {
        ok: true,
        data: {
          ready: runtime.status().state === "applied",
          configuration: runtime.status(),
          backends: await Promise.all(
            (["traex", "codex"] as const).map(async (backend) => {
              try {
                return {
                  backend,
                  version: (
                    await command(
                      runtime.value().config.agents[backend].executable,
                      ["--version"],
                    )
                  ).trim(),
                };
              } catch {
                return { backend, available: false };
              }
            }),
          ),
        },
      };
    if (!["models", "snapshot", "source", "tree", "publish"].includes(method))
      throw new AppError(
        "method_denied",
        "Connector method is not allowed",
        403,
      );
    const lease = await runtime.acquire(loadConfig());
    const { providers, host, config } = lease.runtime;
    try {
      let data: unknown;
      switch (method) {
        case "models":
          if (!["traex", "codex"].includes(p.backend))
            throw new AppError("invalid_input", "Invalid backend");
          data = {
            ...(await host.catalog(p.backend, p.profile)),
            connectionRevision: backendConnectionRevision(config, p.backend),
          };
          break;
        case "snapshot":
          data = await providers.snapshot(p.target);
          break;
        case "source":
          data = await providers.source(p.snapshot, p.path, p.side);
          break;
        case "tree":
          data = await providers.tree(p.snapshot, p.directory, p.side);
          break;
        case "publish":
          data = await providers.publish(p.snapshot, p.body, p.anchor);
          break;
      }
      return { ok: true, data };
    } finally {
      await lease.release();
    }
  });
  app.post("/agent", async (req, res) => {
    if (active)
      throw new AppError(
        "agent_busy",
        "Another agent operation is running",
        409,
      );
    const params = req.body as AgentParams;
    if (
      !["traex", "codex"].includes(params.backend) ||
      !["analysis", "question"].includes(params.kind)
    )
      throw new AppError(
        "invalid_agent_request",
        "Invalid backend or operation",
      );
    const lease = await runtime.acquire(loadConfig());
    try {
      if (active)
        throw new AppError(
          "agent_busy",
          "Another agent operation is running",
          409,
        );
      if (
        params.connectionRevision &&
        params.connectionRevision !==
          backendConnectionRevision(lease.runtime.config, params.backend)
      )
        throw new AppError(
          "configuration_changed",
          "Connection settings changed while preparing this operation; start a new operation",
          409,
        );
      const controller = new AbortController();
      active = { controller, host: lease.runtime.host };
      res.hijack();
      res.raw.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      const disconnect = () => controller.abort();
      res.raw.on("close", disconnect);
      const emit = (event: unknown) => {
        if (!res.raw.destroyed) res.raw.write(JSON.stringify(event) + "\n");
      };
      try {
        await lease.runtime.host.run(params, emit, controller.signal);
      } catch (e: any) {
        emit({
          type: "failure",
          code: e.code || "agent_failed",
          message: e.message,
        });
      } finally {
        active = undefined;
        res.raw.removeListener("close", disconnect);
        await lease.release();
        res.raw.end();
      }
    } finally {
      await lease.release();
    }
  });
  mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
  if (existsSync(config.socketPath)) {
    try {
      await new Promise<void>((resolve, reject) => {
        import("node:net").then(({ connect }) => {
          const c = connect(config.socketPath);
          c.on("connect", () => {
            c.end();
            resolve();
          });
          c.on("error", reject);
        });
      });
      throw new AppError(
        "connector_running",
        "A connector already owns this socket",
        409,
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      unlinkSync(config.socketPath);
    }
  }
  app.addHook("onClose", async () => {
    active?.controller.abort();
  });
  await app.listen({ path: config.socketPath });
  chmodSync(config.socketPath, 0o600);
  return app;
}
