import { EventEmitter } from "node:events";
import { type Config, localRoot, secret, shareUrl } from "./config.js";
import { Store } from "./store.js";
import { connectorRequest, connectorStream } from "./rpc.js";
import { identity, parseTarget } from "./providers.js";
import {
  AppError,
  type Approval,
  type ActiveOperation,
  type Backend,
  type ConfigApplication,
  type ModelProfile,
  type Draft,
  type Explanation,
  type Reference,
  type Review,
  type Run,
  type Snapshot,
  type Source,
} from "./types.js";
import { hash, id, now } from "./util.js";
import { diffLines, validateAnchor } from "./diff.js";
import { applyRunEvent } from "./telemetry.js";
import type { AgentEvent } from "./types.js";

export class Service {
  store: Store;
  events = new EventEmitter();
  controllers = new Map<string, AbortController>();
  tasks = new Map<string, Promise<void>>();
  token: string;
  closed = false;
  constructor(public config: Config) {
    this.store = new Store(config.dataDir);
    this.token = secret(localRoot(), "connector-token");
    for (const r of this.store.list<Run>("run"))
      if (["running", "awaiting_approval"].includes(r.state)) {
        r.state = "interrupted";
        r.error = "Service restarted; operation was not replayed";
        this.store.put("run", r);
      }
    for (const a of this.store.list<Approval>("approval"))
      if (["pending", "approved"].includes(a.state)) {
        a.state = "interrupted";
        this.store.put("approval", a);
      }
    for (const d of this.store.list<Draft>("draft"))
      if (d.state === "publishing") {
        d.state = "unknown";
        d.error = "Restarted while publishing. Reconcile before retrying.";
        this.store.put("draft", d);
      }
  }
  rpc<T>(method: string, params: unknown) {
    return connectorRequest<T>(
      this.config.socketPath,
      this.token,
      method,
      params,
    );
  }
  async configurationStatus(apply = false): Promise<ConfigApplication> {
    try {
      return await this.rpc<ConfigApplication>(
        apply ? "reload_config" : "config_status",
        {},
      );
    } catch (error: any) {
      return {
        state: "unavailable",
        error: error.message || "Connector is unavailable",
      };
    }
  }
  review(reviewId: string) {
    const review = this.store.get<Review>("review", reviewId);
    return {
      ...review,
      backend: review.backendOverride || this.config.defaultBackend,
    };
  }
  version(reviewId: string, versionId?: string) {
    const r = this.review(reviewId);
    const s = this.store.get<Snapshot & { reviewId: string }>(
      "version",
      versionId || r.versionId,
    );
    if (s.reviewId !== reviewId)
      throw new AppError("not_found", "Version not found in this review", 404);
    // Counts are derived presentation data; source identity remains immutable.
    return {
      ...s,
      files: s.files.map((f) => ({
        ...f,
        added: Math.max(
          f.added,
          diffLines(f.patch).filter((l) => l.kind === "add").length,
        ),
        deleted: Math.max(
          f.deleted,
          diffLines(f.patch).filter((l) => l.kind === "delete").length,
        ),
      })),
    };
  }
  async import(url: string, backend?: Backend) {
    const target = parseTarget(url, this.config),
      key = identity(target);
    const existing = this.store.lookup<Review>("review", key);
    if (existing) return existing;
    const snapshot = await this.rpc<Snapshot>("snapshot", { target });
    const concurrent = this.store.lookup<Review>("review", key);
    if (concurrent) return concurrent;
    const r: Review = {
      id: id(),
      identity: key,
      target,
      title: snapshot.title,
      backend: backend || this.config.defaultBackend,
      backendOverride: backend,
      versionId: snapshot.id,
      createdAt: now(),
    };
    this.store.put("version", { ...snapshot, reviewId: r.id });
    this.store.put("discussion", { id: r.id, comments: snapshot.comments });
    this.store.put("review", r, key);
    return r;
  }
  async refresh(reviewId: string) {
    const r = this.review(reviewId);
    const fresh = await this.rpc<Snapshot>("snapshot", { target: r.target });
    if (!this.store.maybe("version", fresh.id))
      this.store.put("version", { ...fresh, reviewId });
    this.store.put("discussion", { id: reviewId, comments: fresh.comments });
    r.title = fresh.title;
    r.versionId = fresh.id;
    this.store.put("review", r);
    return this.bundle(reviewId);
  }
  bundle(reviewId: string, explanationId?: string) {
    const r = this.review(reviewId);
    let explanation = explanationId
      ? this.store.get<Explanation>("explanation", explanationId)
      : r.explanationId
        ? this.store.get<Explanation>("explanation", r.explanationId)
        : undefined;
    if (explanation && explanation.reviewId !== reviewId)
      throw new AppError("not_found", "Explanation not found", 404);
    const version = this.version(
      reviewId,
      explanation?.versionId || r.versionId,
    );
    return {
      review: r,
      version,
      latestVersionId: r.versionId,
      explanation: explanation
        ? this.publicExplanation(explanation)
        : undefined,
      stale: !!explanation && explanation.versionId !== r.versionId,
      comments:
        this.store.maybe<{ comments: unknown[] }>("discussion", reviewId)
          ?.comments || version.comments,
    };
  }
  publicExplanation(e: Explanation) {
    const { threadId, ...publicFields } = e;
    return publicFields;
  }
  async source(
    reviewId: string,
    versionId: string,
    filePath: string,
    side: "old" | "new",
    owner: boolean,
  ) {
    const s = this.version(reviewId, versionId);
    const key = hash(`${s.id}:${side}:${filePath}`).slice(0, 32);
    if (
      !owner &&
      !this.store
        .list<Explanation>("explanation", reviewId)
        .some(
          (e) =>
            e.versionId === versionId &&
            e.references.some((ref) => ref.sourceId === key),
        )
    )
      throw new AppError(
        "source_not_shared",
        "This source was not included in the shared explanation evidence",
        404,
      );
    let source = this.store.maybe<Source>("source", key);
    if (!source) {
      if (!owner)
        throw new AppError(
          "source_not_shared",
          "This source was not included in the shared evidence",
          404,
        );
      source = await this.rpc<Source>("source", {
        snapshot: s,
        path: filePath,
        side,
      });
      this.store.put("source", source);
    }
    return source;
  }
  reference(reviewId: string, referenceId: string) {
    const ref = this.store.get<Reference & { versionId: string }>(
      "reference",
      referenceId,
    );
    this.version(reviewId, ref.versionId);
    return ref;
  }
  async createReference(
    reviewId: string,
    versionId: string,
    path: string,
    side: "old" | "new",
    start: number,
    end: number,
  ) {
    const source = await this.source(reviewId, versionId, path, side, true);
    if (
      start < 1 ||
      end < start ||
      end - start > 500 ||
      end > source.content.split("\n").length
    )
      throw new AppError(
        "invalid_range",
        "Select a valid source range of at most 501 lines",
      );
    const ref = {
      id: hash(`${source.id}:${start}:${end}`).slice(0, 24),
      sourceId: source.id,
      versionId,
      path,
      side,
      start,
      end,
      commit: source.commit,
    };
    this.store.put("reference", ref);
    return ref;
  }
  activeOperation(): ActiveOperation | null {
    const runId = this.controllers.keys().next().value;
    if (!runId) return null;
    const run = this.store.maybe<Run>("run", runId);
    if (!run) return null;
    return {
      id: run.id,
      reviewId: run.reviewId,
      title: this.review(run.reviewId).title,
      kind: run.kind,
      state: run.state,
      backend: run.backend,
      model: run.model,
      stopping: !!this.controllers.get(runId)?.signal.aborted,
    };
  }
  private requireIdle() {
    if (this.controllers.size)
      throw new AppError(
        "agent_busy",
        "另一个 Agent 任务正在运行，请先查看正在运行的任务。",
        409,
        { activeRun: this.activeOperation() },
      );
  }
  async startRun(
    reviewId: string,
    kind: "analysis" | "question",
    options: {
      backend?: Backend;
      model?: string;
      effort?: string | null;
      question?: string;
      referenceId?: string;
      explanationId?: string;
    },
  ) {
    this.requireIdle();
    const r = this.review(reviewId);
    const explanation = options.explanationId
      ? this.store.get<Explanation>("explanation", options.explanationId)
      : r.explanationId
        ? this.store.get<Explanation>("explanation", r.explanationId)
        : undefined;
    if (explanation && explanation.reviewId !== reviewId)
      throw new AppError("not_found", "Explanation not found", 404);
    const context = options.referenceId
      ? this.reference(reviewId, options.referenceId)
      : undefined;
    const versionId =
      kind === "question"
        ? context?.versionId || explanation?.versionId || r.versionId
        : r.versionId;
    const backend = options.backend || r.backend;
    const requestedProfile: ModelProfile = {
      model:
        options.model ||
        r.agentOverrides?.[backend]?.model ||
        this.config.agents[backend].model,
      effort:
        options.effort === null ||
        (options.effort === undefined &&
          r.agentOverrides?.[backend]?.modelDefaultEffort)
          ? undefined
          : options.effort ||
            r.agentOverrides?.[backend]?.effort ||
            this.config.agents[backend].effort,
    };
    const profile = await this.rpc<
      ModelProfile & { connectionRevision?: string }
    >("models", {
      backend,
      profile: requestedProfile,
    });
    this.requireIdle();
    const run: Run = {
      id: id(),
      reviewId,
      versionId,
      kind,
      state: "running",
      backend,
      ...profile,
      requestedProfile,
      connectionRevision: profile.connectionRevision,
      question: options.question,
      context,
      explanationId: kind === "question" ? explanation?.id : undefined,
      createdAt: now(),
    };
    this.store.put("run", run);
    const control = new AbortController();
    this.controllers.set(run.id, control);
    this.record(run.id, {
      type: "status",
      stage: "starting",
      message: "正在准备固定版本调查",
    });
    const previous = this.store
      .list<Run>("run", reviewId)
      .filter(
        (p) =>
          p.kind === "question" &&
          p.state === "succeeded" &&
          p.versionId === versionId,
      )
      .slice(0, 12)
      .reverse();
    const latestQuestion = previous.at(-1);
    const threadId =
      kind === "question" &&
      latestQuestion?.backend === backend &&
      latestQuestion.model === profile.model &&
      latestQuestion.effort === profile.effort &&
      latestQuestion.connectionRevision === profile.connectionRevision
        ? latestQuestion.threadId
        : undefined;
    const task = this.drive(
      run,
      {
        runId: run.id,
        snapshot: this.version(reviewId, versionId),
        backend,
        profile,
        connectionRevision: profile.connectionRevision,
        kind,
        question: options.question,
        context,
        explanation,
        threadId,
        previousQuestions: previous.map((q) => ({
          question: q.question || "",
          answer: q.answer || "",
        })),
      },
      control,
    );
    this.tasks.set(run.id, task);
    task.then(
      () => this.tasks.delete(run.id),
      () => this.tasks.delete(run.id),
    );
    return run;
  }
  private async drive(run: Run, params: unknown, controller: AbortController) {
    let result = false;
    try {
      await connectorStream(
        this.config.socketPath,
        this.token,
        params,
        (event) => {
          Object.assign(run, this.store.get<Run>("run", run.id));
          if (run.state === "interrupted") return;
          if (event.type === "identity") {
            run.threadId = event.threadId as string;
            run.model = event.model as string;
            run.effort = event.effort as string | undefined;
            run.cliVersion = event.cliVersion as string;
            run.writingStyle = event.writingStyle as Run["writingStyle"];
            this.store.put("run", run);
          } else if (event.type === "source") {
            this.store.put("source", event.source as Source);
            return;
          } else if (event.type === "approval") {
            const a: Approval = {
              id: event.id as string,
              runId: run.id,
              reviewId: run.reviewId,
              versionId: run.versionId,
              request: event.request as Approval["request"],
              digest: event.digest as string,
              state: "pending",
              createdAt: now(),
            };
            this.store.put("approval", a);
            run.state = "awaiting_approval";
            this.store.put("run", run);
          } else if (
            event.type === "execution" ||
            event.type === "execution_failed" ||
            event.type === "approval_denied"
          ) {
            const a = this.store.get<Approval>("approval", event.id as string);
            a.state = event.type === "approval_denied" ? "denied" : "finished";
            if (event.error) a.error = event.error as string;
            if (event.receipt) a.receipt = event.receipt as Approval["receipt"];
            this.store.put("approval", a);
            run.state = "running";
            this.store.put("run", run);
          } else if (event.type === "failure")
            throw new AppError(
              event.code as string,
              event.message as string,
              502,
            );
          else if (event.type === "result") {
            result = true;
            run.state = "succeeded";
            run.finishedAt = now();
            run.threadId = event.threadId as string;
            run.model = event.model as string;
            run.effort = event.effort as string | undefined;
            run.cliVersion = event.cliVersion as string;
            if (run.kind === "analysis") {
              const artifact = event.artifact as Pick<
                Explanation,
                "title" | "summary" | "html" | "references" | "guide"
              >;
              const e: Explanation = {
                ...artifact,
                id: id(),
                reviewId: run.reviewId,
                versionId: run.versionId,
                backend: run.backend,
                model: run.model,
                effort: run.effort,
                cliVersion: run.cliVersion,
                threadId: run.threadId,
                writingStyle: run.writingStyle,
                createdAt: now(),
              };
              this.store.put("explanation", e);
              for (const ref of e.references)
                this.store.put("reference", {
                  ...ref,
                  versionId: run.versionId,
                });
              const r = this.review(run.reviewId);
              r.explanationId = e.id;
              this.store.put("review", r);
              run.explanationId = e.id;
            } else {
              run.answer = event.answer as string;
              for (const ref of (event.references || []) as Reference[])
                this.store.put("reference", {
                  ...ref,
                  versionId: run.versionId,
                });
            }
            this.store.put("run", run);
            this.record(run.id, {
              type: "finished",
              state: run.state,
              explanationId: run.explanationId,
            });
            return;
          }
          this.record(
            run.id,
            event.type === "approval"
              ? { type: event.type, id: event.id }
              : event,
          );
        },
        controller.signal,
      );
      if (!result && run.state !== "interrupted")
        throw new AppError(
          "stream_interrupted",
          "Agent stream ended without a terminal result",
          502,
        );
    } catch (e: any) {
      if (run.state !== "interrupted") {
        run.state = "failed";
        run.error = e.message;
        run.errorCode = e.code;
        run.finishedAt = now();
        this.store.put("run", run);
        this.record(run.id, {
          type: "finished",
          state: run.state,
          error: run.error,
          code: run.errorCode,
        });
      }
    } finally {
      this.controllers.delete(run.id);
      for (const a of this.store.list<Approval>("approval", run.reviewId))
        if (a.runId === run.id && ["pending", "approved"].includes(a.state)) {
          a.state = "interrupted";
          this.store.put("approval", a);
        }
    }
  }
  record(runId: string, event: unknown) {
    const stamped = { ...(event as AgentEvent), at: now() };
    let seq: number;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      seq = this.store.event(runId, stamped);
      const run = this.store.maybe<Run>("run", runId);
      if (run) this.store.put("run", applyRunEvent(run, { seq, ...stamped }));
      this.store.db.exec("COMMIT");
    } catch (error) {
      this.store.db.exec("ROLLBACK");
      throw error;
    }
    this.events.emit(runId, { seq, ...stamped });
  }
  cancel(runId: string) {
    const r = this.store.get<Run>("run", runId);
    if (!["running", "awaiting_approval"].includes(r.state)) return r;
    r.state = "interrupted";
    r.finishedAt = now();
    this.store.put("run", r);
    this.controllers.get(runId)?.abort();
    this.record(runId, { type: "finished", state: r.state });
    return r;
  }
  createDraft(
    reviewId: string,
    body: string,
    referenceId?: string,
    versionId?: string,
  ) {
    const r = this.review(reviewId);
    const anchor = referenceId
      ? this.reference(reviewId, referenceId)
      : undefined;
    const s = this.version(
      reviewId,
      anchor?.versionId || versionId || r.versionId,
    );
    if (anchor) validateAnchor(s, anchor);
    const d: Draft = {
      id: id(),
      reviewId,
      versionId: s.id,
      body,
      anchor,
      state: "draft",
      revision: 1,
      createdAt: now(),
    };
    return this.store.put("draft", d);
  }
  editDraft(draftId: string, body: string, revision: number, general = false) {
    const d = this.store.get<Draft>("draft", draftId);
    if (d.state !== "draft" || d.revision !== revision)
      throw new AppError(
        "draft_conflict",
        "Draft changed or is no longer editable",
        409,
      );
    d.body = body;
    d.revision++;
    if (general) {
      d.anchor = undefined;
      d.versionId = this.review(d.reviewId).versionId;
    }
    return this.store.put("draft", d);
  }
  renderDraft(d: Draft) {
    const s = this.version(d.reviewId, d.versionId);
    let body = `${d.body.trim()}\n\n---\nReviewed revision: \`${s.head}\` (${s.target.url})`;
    if (d.anchor)
      body += `\nCode: \`${d.anchor.path}:${d.anchor.start}${d.anchor.end !== d.anchor.start ? `–${d.anchor.end}` : ""}\` (${d.anchor.side} side).`;
    // A github.com PR may be public. Its draft must not automatically disclose
    // the owner's company-network share entry. The skill returns that link
    // separately for the caller's explicitly authorized review handoff.
    if (s.target.provider === "codebase") {
      try {
        body += `\nExplanation: ${shareUrl(this.config, d.reviewId)}`;
      } catch {}
    }
    return body;
  }
  preview(draftId: string) {
    const d = this.store.get<Draft>("draft", draftId),
      r = this.review(d.reviewId);
    if (d.state !== "draft")
      throw new AppError(
        "draft_not_editable",
        "This draft is already published or needs reconciliation",
        409,
      );
    if (d.versionId !== r.versionId)
      throw new AppError(
        "stale_draft",
        "Refresh and relocate this draft or explicitly convert it to a current general comment",
        409,
      );
    if (d.anchor)
      validateAnchor(this.version(d.reviewId, d.versionId), d.anchor);
    const body = this.renderDraft(d),
      digest = hash({
        draftId: d.id,
        revision: d.revision,
        versionId: d.versionId,
        anchor: d.anchor,
        body,
      });
    return {
      draftId: d.id,
      revision: d.revision,
      versionId: d.versionId,
      kind: d.anchor ? "inline" : "general",
      body,
      digest,
      warning: d.anchor
        ? null
        : `This will be posted as a general ${r.target.provider === "github" ? "PR" : "MR"} comment.`,
    };
  }
  async publish(draftId: string, confirm: string) {
    let d = this.store.get<Draft>("draft", draftId);
    if (d.state === "published") return d;
    if (d.state !== "draft")
      throw new AppError(
        "publication_unknown",
        "Reconcile this publication instead of repeating it",
        409,
      );
    const preview = this.preview(draftId);
    if (confirm !== preview.digest)
      throw new AppError(
        "confirmation_required",
        "Preview and confirm this exact content first",
        409,
        preview,
      );
    const old = this.version(d.reviewId, d.versionId),
      fresh = await this.rpc<Snapshot>("snapshot", { target: old.target });
    if (fresh.head !== old.head || fresh.base !== old.base)
      throw new AppError(
        "stale_draft",
        `The ${old.target.provider === "github" ? "PR" : "MR"} changed since preview. Refresh and relocate the draft.`,
        409,
      );
    // Re-read after asynchronous preflight: edits and concurrent submissions must not win a race.
    d = this.store.get<Draft>("draft", draftId);
    if (d.state !== "draft" || this.preview(draftId).digest !== confirm)
      throw new AppError(
        "draft_conflict",
        "Draft was edited or submitted during preflight",
        409,
      );
    const publicationId = id();
    d.state = "publishing";
    d.publicationId = publicationId;
    this.store.put("draft", d);
    try {
      const remote = await this.rpc<{ id: string }>("publish", {
        snapshot: old,
        body: `${preview.body}\n\n<!-- unfold-publication:${publicationId} -->`,
        anchor: d.anchor,
      });
      d.state = "published";
      d.remoteId = remote.id;
      d.error = undefined;
    } catch (e: any) {
      d.state = "unknown";
      d.error = e.message;
    }
    this.store.put("draft", d);
    return d;
  }
  async reconcile(draftId: string) {
    const d = this.store.get<Draft>("draft", draftId);
    if (!d.publicationId || !["unknown", "publishing"].includes(d.state))
      return d;
    const fresh = await this.rpc<Snapshot>("snapshot", {
      target: this.review(d.reviewId).target,
    });
    const found = fresh.comments.find((c) =>
      c.body.includes(`<!-- unfold-publication:${d.publicationId} -->`),
    );
    if (found) {
      d.state = "published";
      d.remoteId = found.id;
      d.error = undefined;
      this.store.put("draft", d);
    }
    this.store.put("discussion", { id: d.reviewId, comments: fresh.comments });
    return d;
  }
  async decide(approvalId: string, digest: string, approve: boolean) {
    const a = this.store.get<Approval>("approval", approvalId);
    if (a.state !== "pending" || a.digest !== digest)
      throw new AppError(
        "approval_expired",
        "Approval is no longer pending or its digest changed",
        409,
      );
    const r = this.store.get<Run>("run", a.runId);
    if (r.state !== "awaiting_approval" || r.versionId !== a.versionId)
      throw new AppError(
        "approval_expired",
        "The originating operation is no longer waiting",
        409,
      );
    a.state = approve ? "approved" : "denied";
    this.store.put("approval", a);
    try {
      await this.rpc("approval", { id: a.id, digest, approve });
    } catch (e) {
      a.state = "interrupted";
      this.store.put("approval", a);
      throw e;
    }
    return a;
  }
  async shutdown() {
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.tasks.values()]);
    this.close();
  }
  close() {
    if (this.closed) return;
    for (const c of this.controllers.values()) c.abort();
    this.store.close();
    this.closed = true;
  }
}
