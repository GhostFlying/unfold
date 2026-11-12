import Fastify from "fastify";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { type Config, loadConfig, localRoot, secret } from "./config.js";
import { Providers } from "./providers.js";
import { AgentHost, type AgentParams } from "./agent.js";
import { AppError } from "./types.js";
import { equal, command } from "./util.js";

export async function startConnector(config: Config) {
  const root = localRoot(),
    token = secret(root, "connector-token");
  const providers = new Providers(config),
    host = new AgentHost(config, root, providers);
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  let active: AbortController | undefined;
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
    let data: unknown;
    switch (method) {
      case "health":
        data = {
          ready: true,
          backends: await Promise.all(
            ["traex", "codex"].map(async (b) => {
              try {
                return {
                  backend: b,
                  version: (
                    await command(
                      config.agents[b as "traex" | "codex"].executable,
                      ["--version"],
                    )
                  ).trim(),
                };
              } catch {
                return { backend: b, available: false };
              }
            }),
          ),
        };
        break;
      case "models":
        if (!["traex", "codex"].includes(p.backend))
          throw new AppError("invalid_input", "Invalid backend");
        data = await new AgentHost(loadConfig(), root, providers).catalog(
          p.backend,
          p.profile,
        );
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
      case "approval":
        data = host.decide(p.id, p.digest, p.approve);
        break;
      default:
        throw new AppError(
          "method_denied",
          "Connector method is not allowed",
          403,
        );
    }
    return { ok: true, data };
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
    const controller = new AbortController();
    active = controller;
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
      // Refresh saved defaults for each operation, without affecting an active run.
      hostConfigUpdate(config, loadConfig());
      await host.run(params, emit, controller.signal);
    } catch (e: any) {
      emit({
        type: "failure",
        code: e.code || "agent_failed",
        message: e.message,
      });
    } finally {
      active = undefined;
      res.raw.removeListener("close", disconnect);
      res.raw.end();
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
    active?.abort();
  });
  await app.listen({ path: config.socketPath });
  chmodSync(config.socketPath, 0o600);
  return app;
}

function hostConfigUpdate(config: Config, fresh: Config) {
  config.agents = fresh.agents;
}
