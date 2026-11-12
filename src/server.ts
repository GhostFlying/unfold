import Fastify, { type FastifyRequest } from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z, ZodError } from "zod";
import {
  type Config,
  localRoot,
  secret,
  shareUrl,
  saveConfig,
  settingsRevision,
} from "./config.js";
import {
  AppError,
  type Approval,
  type Draft,
  type Explanation,
  type Review,
  type Run,
} from "./types.js";
import { equal } from "./util.js";
import { parentCsp, exportHtml } from "./html.js";
import { backendConnectionRevision } from "./connector-runtime.js";
import { Service } from "./service.js";
import { ArtifactDraft } from "./artifact-draft.js";

const backend = z.enum(["traex", "codex"]);
const modelProfile = z.object({
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.string().trim().min(1).max(50).nullable().optional(),
  modelDefaultEffort: z.boolean().optional(),
});
const runProfile = z.object({
  backend: backend.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(50).nullable().optional(),
});
const side = z.enum(["old", "new"]);
const bodyText = z.string().trim().min(1).max(100000);
export async function createServer(service: Service, owner: boolean) {
  const app = Fastify({
      bodyLimit: 5 * 1024 * 1024,
      logger: false,
      forceCloseConnections: true,
    }),
    ownerToken = secret(localRoot(), "owner-token");
  const sessions = new Map<string, number>();
  const authenticated = (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    if (auth && equal(auth, `Bearer ${ownerToken}`)) return true;
    const cookie = req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("unfold_session="))
      ?.slice(15);
    return !!cookie && (sessions.get(cookie) || 0) > Date.now();
  };
  const requireOwner = (req: FastifyRequest) => {
    if (!owner || !authenticated(req))
      throw new AppError("unauthorized", "Owner authentication required", 401);
  };
  app.addHook("onRequest", async (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let u: URL;
        try {
          u = new URL(origin);
        } catch {
          throw new AppError("origin_denied", "Origin denied", 403);
        }
        if (
          u.host !== req.headers.host ||
          !["http:", "https:"].includes(u.protocol)
        )
          throw new AppError(
            "origin_denied",
            "Cross-origin writes are forbidden",
            403,
          );
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new AppError(
          "json_required",
          "Write requests require application/json",
          415,
        );
    }
  });
  app.addHook("onSend", async (_req, res, payload) => {
    res
      .header("Content-Security-Policy", parentCsp)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((e: any, _req, res) => {
    const status =
      e instanceof ZodError ? 400 : e.status || e.statusCode || 500;
    res.status(status).send({
      ok: false,
      error: {
        code:
          e instanceof ZodError ? "invalid_input" : e.code || "internal_error",
        message:
          status === 500
            ? "Internal error; inspect the owner console"
            : e.message,
        details: e.details,
      },
    });
  });
  app.addHook("preHandler", async (req) => {
    if (owner && authenticated(req)) return;
    const match = /^\/api\/v1\/reviews\/([^/?]+)(?:\/([^?]+))?/.exec(req.url);
    if (!match || !["GET", "HEAD"].includes(req.method)) return;
    const r = service.review(match[1]);
    if (!r.explanationId)
      throw new AppError("not_found", "No shared explanation exists", 404);
    const q = req.query as any;
    if (
      match[2] === "snapshot" &&
      q.versionId &&
      !service.store
        .list<Explanation>("explanation", r.id)
        .some((e) => e.versionId === q.versionId)
    )
      throw new AppError(
        "not_found",
        "This version has no shared explanation",
        404,
      );
  });
  const ok = (data: unknown) => ({ ok: true, data });
  const param = (req: FastifyRequest, key: string) =>
    (req.params as Record<string, string>)[key];
  app.get("/healthz", async () => ({
    status: "ok",
    mode: owner ? "owner" : "viewer",
  }));
  app.get("/api/v1/bootstrap", async (req) =>
    ok({
      mode: owner ? "owner" : "viewer",
      authenticated: owner && authenticated(req),
    }),
  );
  app.get("/api/v1/reviews/:id", async (req) =>
    ok(service.bundle(param(req, "id"), (req.query as any).explanationId)),
  );
  app.get("/api/v1/reviews/:id/history", async (req) => {
    const reviewId = param(req, "id");
    service.review(reviewId);
    return ok(
      service.store
        .list<Explanation>("explanation", reviewId)
        .map((e) => service.publicExplanation(e)),
    );
  });
  app.get("/api/v1/reviews/:id/guide", async (req) => {
    const q = req.query as { explanationId?: string; point?: string };
    const { review, version, explanation } = service.bundle(
      param(req, "id"),
      q.explanationId,
    );
    if (!explanation?.guide)
      throw new AppError(
        "guide_unavailable",
        "This explanation has no logical change guide; generate a new explanation to add one",
        404,
      );
    const groups = q.point
      ? explanation.guide.groups.flatMap((g) => {
          const points = g.points.filter((p) => p.id === q.point);
          return points.length ? [{ ...g, points }] : [];
        })
      : explanation.guide.groups;
    if (!groups.length)
      throw new AppError("not_found", "Change point not found", 404);
    const ids = new Set(
      groups.flatMap((g) => g.points.flatMap((p) => p.referenceIds)),
    );
    return ok({
      reviewId: review.id,
      explanationId: explanation.id,
      versionId: version.id,
      summary: explanation.summary,
      groups,
      references: explanation.references.filter((r) => ids.has(r.id)),
    });
  });
  app.get("/api/v1/reviews/:id/versions", async (req) => {
    const reviewId = param(req, "id");
    service.review(reviewId);
    return ok(
      service.store.list<any>("version", reviewId).map((s) => ({
        id: s.id,
        head: s.head,
        base: s.base,
        fetchedAt: s.fetchedAt,
        remoteVersion: s.remoteVersion,
      })),
    );
  });
  app.get("/api/v1/reviews/:id/snapshot", async (req) =>
    ok(
      service.version(
        param(req, "id"),
        (req.query as any).versionId ||
          (!(owner && authenticated(req))
            ? service.bundle(param(req, "id")).explanation?.versionId
            : undefined),
      ),
    ),
  );
  app.get("/api/v1/reviews/:id/source", async (req) => {
    const q = z
      .object({ versionId: z.string(), path: z.string(), side })
      .parse(req.query);
    return ok(
      await service.source(
        param(req, "id"),
        q.versionId,
        q.path,
        q.side,
        owner && authenticated(req),
      ),
    );
  });
  app.get("/api/v1/reviews/:id/share", async (req) => {
    const reviewId = param(req, "id");
    service.review(reviewId);
    const explanationId = (req.query as any).explanationId;
    if (explanationId) service.bundle(reviewId, explanationId);
    return ok({ url: shareUrl(service.config, reviewId, explanationId) });
  });
  app.get("/api/v1/reviews/:id/export", async (req, res) => {
    const bundle = service.bundle(
      param(req, "id"),
      (req.query as any).explanationId,
    );
    if (!bundle.explanation)
      throw new AppError("not_found", "No explanation exists", 404);
    return res
      .type("text/html; charset=utf-8")
      .header(
        "Content-Disposition",
        'attachment; filename="unfold-explanation.html"',
      )
      .send(exportHtml(bundle.explanation.title, bundle.explanation.html));
  });

  if (owner) {
    app.post("/api/v1/login", async (req, res) => {
      const b = z.object({ token: z.string().max(1000) }).parse(req.body);
      if (!equal(b.token, ownerToken))
        throw new AppError("unauthorized", "Invalid owner key", 401);
      const session = randomBytes(32).toString("hex");
      sessions.set(session, Date.now() + 12 * 60 * 60_000);
      res.header(
        "set-cookie",
        `unfold_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers.origin?.startsWith("https:") ? "; Secure" : ""}`,
      );
      return ok({ authenticated: true });
    });
    app.post("/api/v1/logout", async (req, res) => {
      requireOwner(req);
      const cookie = req.headers.cookie?.match(
        /(?:^|;\s*)unfold_session=([^;]+)/,
      )?.[1];
      if (cookie) sessions.delete(cookie);
      res.header(
        "set-cookie",
        "unfold_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      return ok({ authenticated: false });
    });
    app.addHook("preHandler", async (req) => {
      if (
        req.url.startsWith("/api/v1/") &&
        !req.url.startsWith("/api/v1/login") &&
        !req.url.startsWith("/api/v1/bootstrap") &&
        !/^\/api\/v1\/reviews\/[^/]+(?:\/(?:source|history|versions|snapshot|share|export|guide))?(?:\?|$)/.test(
          req.url,
        )
      )
        requireOwner(req);
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !req.url.startsWith("/api/v1/login")
      )
        requireOwner(req);
    });
    app.get("/api/v1/config", async () => ok(service.config));
    app.get("/api/v1/config/status", async () =>
      ok(await service.configurationStatus()),
    );
    app.post("/api/v1/config/apply", async () =>
      ok(await service.configurationStatus(true)),
    );
    app.patch("/api/v1/config", async (req) => {
      const patch = z
        .object({
          defaultBackend: backend.optional(),
          shareBaseUrl: z.string().optional(),
          codebaseHosts: z
            .array(z.string().regex(/^[a-zA-Z0-9.-]+$/))
            .optional(),
          ownerBaseUrl: z.string().url().optional(),
          agents: z
            .partialRecord(
              backend,
              z.object({
                model: z.string().min(1).optional(),
                effort: z.string().min(1).optional(),
                executable: z.string().min(1),
                authFile: z.string(),
                provider: z.string().optional(),
                providerConfig: z.record(z.string(), z.unknown()).optional(),
              }),
            )
            .optional(),
        })
        .strict()
        .parse(req.body);
      const next = {
        ...service.config,
        ...patch,
        agents: { ...service.config.agents, ...patch.agents },
      };
      if (patch.agents)
        for (const b of ["traex", "codex"] as const) {
          if (
            patch.agents[b] &&
            settingsRevision(patch.agents[b]) !==
              settingsRevision(service.config.agents[b]) &&
            backendConnectionRevision(next, b) ===
              backendConnectionRevision(service.config, b)
          )
            await service.rpc("models", {
              backend: b,
              profile: {
                model: patch.agents[b].model,
                effort: patch.agents[b].effort,
              },
            });
        }
      if (patch.shareBaseUrl) shareUrl(next, "configuration-check");
      saveConfig(next);
      service.config = next;
      return ok({
        config: next,
        saved: true,
        application: await service.configurationStatus(true),
      });
    });

    app.get("/api/v1/agents/:backend/models", async (req) =>
      ok(
        await service.rpc("models", {
          backend: backend.parse(param(req, "backend")),
        }),
      ),
    );
    app.get("/api/v1/reviews/:id/agent", async (req) => {
      const review = service.review(param(req, "id"));
      return ok({
        backend: review.backend,
        backendOverride: review.backendOverride,
        overrides: review.agentOverrides || {},
        profiles: Object.fromEntries(
          (["traex", "codex"] as const).map((b) => [
            b,
            {
              model:
                review.agentOverrides?.[b]?.model ||
                service.config.agents[b].model,
              effort: review.agentOverrides?.[b]?.modelDefaultEffort
                ? undefined
                : review.agentOverrides?.[b]?.effort ||
                  service.config.agents[b].effort,
            },
          ]),
        ),
      });
    });
    app.get("/api/v1/doctor", async () =>
      ok({
        service: { ready: true },
        connector: await service.rpc("health", {}),
      }),
    );
    app.get("/api/v1/activity", async () =>
      ok({ active: service.activeOperation() }),
    );
    app.get("/api/v1/reviews", async () =>
      ok(service.store.list<Review>("review").map((r) => service.review(r.id))),
    );
    app.post("/api/v1/reviews", async (req) => {
      const b = z
        .object({ url: z.string().url(), backend: backend.optional() })
        .parse(req.body);
      return ok(await service.import(b.url, b.backend));
    });
    app.patch("/api/v1/reviews/:id", async (req) => {
      const b = z
        .object({
          backend: backend.nullable().optional(),
          agentOverrides: z.partialRecord(backend, modelProfile).optional(),
        })
        .strict()
        .parse(req.body);
      const r = service.review(param(req, "id"));
      if (b.backend !== undefined) r.backendOverride = b.backend || undefined;
      if (b.agentOverrides) {
        r.agentOverrides = { ...r.agentOverrides };
        for (const [key, patch] of Object.entries(b.agentOverrides)) {
          const bkey = key as "traex" | "codex";
          const next = { ...r.agentOverrides[bkey] };
          for (const field of ["model", "effort"] as const) {
            if (patch[field] === null) delete next[field];
            else if (patch[field] !== undefined) next[field] = patch[field];
          }
          if (patch.effort !== undefined) delete next.modelDefaultEffort;
          if (patch.modelDefaultEffort === true) {
            next.modelDefaultEffort = true;
            delete next.effort;
          } else if (patch.modelDefaultEffort === false) {
            delete next.modelDefaultEffort;
          }
          await service.rpc("models", {
            backend: bkey,
            profile: {
              model: next.model || service.config.agents[bkey].model,
              effort: next.modelDefaultEffort
                ? undefined
                : next.effort || service.config.agents[bkey].effort,
            },
          });
          r.agentOverrides[bkey] = next;
        }
      }
      service.store.put("review", r);
      return ok(service.review(r.id));
    });
    app.post("/api/v1/reviews/:id/refresh", async (req) =>
      ok(await service.refresh(param(req, "id"))),
    );
    app.post("/api/v1/reviews/:id/analyze", async (req) => {
      const b = runProfile.parse(req.body);
      return ok(await service.startRun(param(req, "id"), "analysis", b));
    });
    app.post("/api/v1/reviews/:id/questions", async (req) => {
      const b = z
        .object({
          ...runProfile.shape,
          question: bodyText,
          referenceId: z.string().optional(),
          explanationId: z.string().optional(),
        })
        .parse(req.body);
      return ok(await service.startRun(param(req, "id"), "question", b));
    });
    app.get("/api/v1/reviews/:id/runs", async (req) => {
      service.review(param(req, "id"));
      return ok(service.store.list<Run>("run", param(req, "id")));
    });
    app.post("/api/v1/reviews/:id/references", async (req) => {
      const b = z
        .object({
          versionId: z.string(),
          path: z.string(),
          side,
          start: z.number().int().positive(),
          end: z.number().int().positive(),
        })
        .parse(req.body);
      return ok(
        await service.createReference(
          param(req, "id"),
          b.versionId,
          b.path,
          b.side,
          b.start,
          b.end,
        ),
      );
    });
    app.get("/api/v1/reviews/:id/drafts", async (req) => {
      service.review(param(req, "id"));
      return ok(service.store.list<Draft>("draft", param(req, "id")));
    });
    app.post("/api/v1/reviews/:id/drafts", async (req) => {
      const b = z
        .object({
          body: bodyText,
          referenceId: z.string().optional(),
          versionId: z.string().optional(),
        })
        .parse(req.body);
      return ok(
        service.createDraft(
          param(req, "id"),
          b.body,
          b.referenceId,
          b.versionId,
        ),
      );
    });
    app.patch("/api/v1/drafts/:id", async (req) => {
      const b = z
        .object({
          body: bodyText,
          revision: z.number().int().positive(),
          general: z.boolean().optional(),
        })
        .parse(req.body);
      return ok(
        service.editDraft(param(req, "id"), b.body, b.revision, !!b.general),
      );
    });
    app.get("/api/v1/drafts/:id", async (req) =>
      ok(service.store.get<Draft>("draft", param(req, "id"))),
    );
    app.post("/api/v1/drafts/:id/preview", async (req) =>
      ok(service.preview(param(req, "id"))),
    );
    app.post("/api/v1/drafts/:id/publish", async (req) => {
      const b = z.object({ confirm: z.string().length(64) }).parse(req.body);
      const d = await service.publish(param(req, "id"), b.confirm);
      return ok(d);
    });
    app.post("/api/v1/drafts/:id/reconcile", async (req) =>
      ok(await service.reconcile(param(req, "id"))),
    );
    app.get("/api/v1/approvals", async () =>
      ok(service.store.list<Approval>("approval")),
    );
    app.post("/api/v1/approvals/:id/decision", async (req) => {
      const b = z
        .object({ confirm: z.string().length(64), approve: z.boolean() })
        .parse(req.body);
      return ok(await service.decide(param(req, "id"), b.confirm, b.approve));
    });
    app.get("/api/v1/runs/:id", async (req) =>
      ok(service.store.get<Run>("run", param(req, "id"))),
    );
    app.post("/api/v1/runs/:id/cancel", async (req) =>
      ok(service.cancel(param(req, "id"))),
    );
    app.get("/api/v1/runs/:id/artifact", async (req) => {
      const run = service.store.get<Run>("run", param(req, "id"));
      if (run.kind !== "analysis")
        throw new AppError(
          "invalid_run_kind",
          "Private questions do not create explanation parts",
        );
      const query = z
        .object({ content: z.enum(["0", "1"]).optional() })
        .parse(req.query);
      return ok(
        new ArtifactDraft(service.config.dataDir, run.id, run.versionId).read(
          query.content === "1",
        ),
      );
    });
    app.get("/api/v1/runs/:id/events", async (req, res) => {
      const runId = param(req, "id");
      service.store.get<Run>("run", runId);
      const after = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(req.headers["last-event-id"] || (req.query as any).after || 0);
      res.hijack();
      res.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.raw.flushHeaders();
      let cursor = after;
      const write = (event: any) => {
        if (event.seq > cursor && !res.raw.destroyed) {
          cursor = event.seq;
          res.raw.write(`id: ${cursor}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      };
      service.events.on(runId, write);
      let page;
      do {
        page = service.store.events(runId, cursor);
        for (const event of page) write(event);
      } while (page.length === 500);
      const timer = setInterval(() => res.raw.write(": keepalive\n\n"), 15_000);
      res.raw.on("close", () => {
        clearInterval(timer);
        service.events.removeListener(runId, write);
      });
    });
  }
  const staticDir = path.resolve("dist/web");
  if (existsSync(staticDir))
    await app.register(staticPlugin, { root: staticDir, wildcard: false });
  app.setNotFoundHandler(async (req, res) => {
    if (req.url.startsWith("/api/"))
      return res.status(404).send({
        ok: false,
        error: {
          code: "not_found",
          message: "Endpoint not available on this listener",
        },
      });
    if (existsSync(path.join(staticDir, "index.html")))
      return res.type("text/html").sendFile("index.html");
    return res
      .type("text/html")
      .send("<h1>Unfold</h1><p>Run pnpm build to build the interface.</p>");
  });
  return app;
}
export async function startServers(config: Config) {
  const service = new Service(config);
  const owner = await createServer(service, true),
    viewer = await createServer(service, false);
  try {
    await owner.listen({
      host: process.env.UNFOLD_CONTAINER ? "0.0.0.0" : "127.0.0.1",
      port: config.ownerPort,
    });
    await viewer.listen({ host: config.shareBind, port: config.sharePort });
  } catch (e) {
    await owner.close();
    await viewer.close();
    service.close();
    throw e;
  }
  return {
    owner,
    viewer,
    service,
    close: async () => {
      await service.shutdown();
      await Promise.all([owner.close(), viewer.close()]);
    },
  };
}
