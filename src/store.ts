import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "./types.js";
import { tokenCounts } from "./telemetry.js";
export class Store {
  db: DatabaseSync;
  private artifacts: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.artifacts = path.join(dir, "artifacts");
    this.db = new DatabaseSync(path.join(dir, "unfold.sqlite"));
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS items(kind TEXT NOT NULL,id TEXT NOT NULL,review_id TEXT NOT NULL DEFAULT '',lookup_key TEXT,data TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE UNIQUE INDEX IF NOT EXISTS lookup_idx ON items(kind,lookup_key) WHERE lookup_key IS NOT NULL; CREATE INDEX IF NOT EXISTS review_idx ON items(kind,review_id); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,data TEXT NOT NULL);`,
    );
    for (const row of this.db
      .prepare(
        "SELECT kind,data FROM items WHERE kind IN ('source','explanation')",
      )
      .all()) {
      const item = JSON.parse(row.data as string);
      if (row.kind === "explanation" && typeof item.html === "string")
        this.put("explanation", item);
      else if (row.kind === "source") this.saveArtifact("source", item);
    }
  }
  private hydrate(kind: string, data: string) {
    const item = JSON.parse(data);
    if (kind === "run" && item.usage && !tokenCounts(item.usage)) {
      delete item.usage;
      item.usageUnavailableReason =
        "Recorded usage is incomplete or inconsistent";
    }
    if (kind !== "explanation" || typeof item.html === "string") return item;
    const expected = path.join("explanation", item.id + ".html");
    if (!/^[a-zA-Z0-9_-]+$/.test(item.id) || item.htmlFile !== expected)
      throw new AppError(
        "invalid_artifact",
        "Invalid explanation artifact path",
        500,
      );
    try {
      item.html = readFileSync(path.join(this.artifacts, expected), "utf8");
    } catch {
      throw new AppError(
        "artifact_missing",
        "Explanation HTML file is unavailable",
        500,
      );
    }
    delete item.htmlFile;
    return item;
  }
  private saveArtifact(kind: string, item: any) {
    if (kind !== "source" && kind !== "explanation") return;
    if (!/^[a-zA-Z0-9_-]+$/.test(item.id))
      throw new AppError("invalid_id", "Invalid artifact identity");
    const dir = path.join(this.artifacts, kind);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(
      dir,
      item.id + (kind === "source" ? ".json" : ".html"),
    );
    writeFileSync(
      target + ".tmp",
      kind === "source" ? JSON.stringify(item) + "\n" : item.html,
      { mode: 0o600 },
    );
    renameSync(target + ".tmp", target);
  }
  put<T extends { id: string; reviewId?: string }>(
    kind: string,
    item: T,
    key?: string,
  ) {
    this.saveArtifact(kind, item);
    let persisted: object = item;
    if (kind === "explanation") {
      const { html, ...metadata } = item as T & { html: string };
      persisted = {
        ...metadata,
        htmlFile: path.join("explanation", item.id + ".html"),
      };
    }
    this.db
      .prepare(
        "INSERT INTO items(kind,id,review_id,lookup_key,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,review_id=excluded.review_id",
      )
      .run(
        kind,
        item.id,
        item.reviewId || "",
        key ?? null,
        JSON.stringify(persisted),
      );
    return item;
  }
  get<T>(kind: string, id: string): T {
    const row = this.db
      .prepare("SELECT data FROM items WHERE kind=? AND id=?")
      .get(kind, id) as { data: string } | undefined;
    if (!row) throw new AppError("not_found", `${kind} not found`, 404);
    return this.hydrate(kind, row.data);
  }
  maybe<T>(kind: string, id: string): T | undefined {
    try {
      return this.get<T>(kind, id);
    } catch (e) {
      if (e instanceof AppError && e.code === "not_found") return;
      throw e;
    }
  }
  lookup<T>(kind: string, key: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM items WHERE kind=? AND lookup_key=?")
      .get(kind, key) as { data: string } | undefined;
    return row ? this.hydrate(kind, row.data) : undefined;
  }
  list<T>(kind: string, reviewId?: string): T[] {
    const rows =
      reviewId === undefined
        ? this.db
            .prepare("SELECT data FROM items WHERE kind=? ORDER BY rowid DESC")
            .all(kind)
        : this.db
            .prepare(
              "SELECT data FROM items WHERE kind=? AND review_id=? ORDER BY rowid DESC",
            )
            .all(kind, reviewId);
    return rows.map((r) => this.hydrate(kind, r.data as string));
  }
  event(runId: string, data: unknown) {
    const r = this.db
      .prepare("INSERT INTO events(run_id,data) VALUES(?,?)")
      .run(runId, JSON.stringify(data));
    return Number(r.lastInsertRowid);
  }
  events(runId: string, after = 0) {
    return this.db
      .prepare(
        "SELECT seq,data FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500",
      )
      .all(runId, after)
      .map((r) => ({ seq: Number(r.seq), ...JSON.parse(r.data as string) }));
  }
  close() {
    this.db.close();
  }
}
