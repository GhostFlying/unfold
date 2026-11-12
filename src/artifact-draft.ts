import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AppError, type Reference } from "./types.js";
import { guideSchema } from "./guide.js";
import { hash, id, now } from "./util.js";

export const artifactPartSchema = z
  .object({
    kind: z.enum(["overview", "guide", "html"]),
    index: z.number().int().min(1).max(256),
    content: z.string().min(1).max(16000),
  })
  .strict();
const overviewSchema = z
  .object({
    title: z.string().min(1).max(1000),
    summary: z.string().min(1).max(6000),
  })
  .strict();
type Part = {
  kind: "overview" | "guide" | "html";
  index: number;
  characters: number;
  sha256: string;
};
type Manifest = {
  runId: string;
  versionId: string;
  updatedAt: string;
  parts: Part[];
  references: Reference[];
  writes: number;
  writtenChars: number;
};

// Connector writes private files; the service remains the sole SQLite writer.
export class ArtifactDraft {
  private directory: string;
  constructor(
    dataDir: string,
    private runId: string,
    private versionId: string,
  ) {
    if (
      ![runId, versionId].every((value) => /^[a-zA-Z0-9_-]{1,100}$/.test(value))
    )
      throw new AppError(
        "invalid_artifact_identity",
        "Invalid artifact identity",
      );
    this.directory = path.join(dataDir, "artifacts", "in-progress", runId);
  }
  private filename(part: Pick<Part, "kind" | "index">) {
    return path.join(this.directory, `${part.kind}-${part.index}.txt`);
  }
  private manifest(): Manifest {
    const file = path.join(this.directory, "manifest.json");
    if (!existsSync(file))
      return {
        runId: this.runId,
        versionId: this.versionId,
        updatedAt: now(),
        parts: [],
        references: [],
        writes: 0,
        writtenChars: 0,
      };
    if (statSync(file).size > 4 * 1024 * 1024)
      throw new AppError("invalid_artifact", "Artifact manifest is too large");
    const value = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    if (value.runId !== this.runId || value.versionId !== this.versionId)
      throw new AppError(
        "artifact_version_conflict",
        "Artifact belongs to another source version",
        409,
      );
    if (
      !Array.isArray(value.parts) ||
      value.parts.length > 273 ||
      !Array.isArray(value.references)
    )
      throw new AppError("invalid_artifact", "Invalid artifact manifest");
    for (const p of value.parts) {
      artifactPartSchema
        .omit({ content: true })
        .parse({ kind: p.kind, index: p.index });
      if (
        !Number.isSafeInteger(p.characters) ||
        p.characters < 1 ||
        p.characters > 16000 ||
        !/^[a-f0-9]{64}$/.test(p.sha256)
      )
        throw new AppError("invalid_artifact", "Invalid artifact part");
    }
    return value;
  }
  private atomic(file: string, content: string) {
    const temp = `${file}.${id()}.tmp`;
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  }
  save(input: unknown, references: Reference[]) {
    const part = artifactPartSchema.parse(input);
    if (
      (part.kind === "overview" && part.index !== 1) ||
      (part.kind === "guide" && part.index > 16)
    )
      throw new AppError(
        "invalid_artifact_part",
        "Overview has one part; guide has at most 16 groups",
      );
    if (part.kind === "overview")
      overviewSchema.parse(JSON.parse(part.content));
    if (part.kind === "guide")
      guideSchema.shape.groups.element.parse(JSON.parse(part.content));
    const manifest = this.manifest();
    const entry: Part = {
      kind: part.kind,
      index: part.index,
      characters: part.content.length,
      sha256: hash(part.content),
    };
    const changed = !manifest.parts.some(
      (p) =>
        p.kind === part.kind &&
        p.index === part.index &&
        p.sha256 === entry.sha256,
    );
    if (
      changed &&
      (manifest.writes >= 1024 ||
        manifest.writtenChars + part.content.length > 8 * 1024 * 1024)
    )
      throw new AppError(
        "artifact_too_large",
        "Artifact replacement budget exceeded",
      );
    const parts = [
      ...manifest.parts.filter(
        (p) => p.kind !== part.kind || p.index !== part.index,
      ),
      entry,
    ];
    if (parts.reduce((total, p) => total + p.characters, 0) > 4 * 1024 * 1024)
      throw new AppError(
        "artifact_too_large",
        "Saved explanation exceeds 4 MiB",
      );
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Content-addressed names keep a replacement atomic with its manifest.
    this.atomic(this.filenameWithHash(entry), part.content);
    this.atomic(
      path.join(this.directory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        updatedAt: now(),
        writes: manifest.writes + Number(changed),
        writtenChars:
          manifest.writtenChars + (changed ? part.content.length : 0),
        parts: parts.sort(
          (a, b) => a.kind.localeCompare(b.kind) || a.index - b.index,
        ),
        references: [
          ...new Map(
            [...manifest.references, ...references].map((ref) => [ref.id, ref]),
          ).values(),
        ],
      }),
    );
    return {
      saved: true,
      kind: part.kind,
      index: part.index,
      ...this.progress(),
    };
  }
  private filenameWithHash(part: Part) {
    return `${this.filename(part)}.${part.sha256}`;
  }
  private content(part: Part) {
    const file = this.filenameWithHash(part);
    if (statSync(file).size > 64000)
      throw new AppError("invalid_artifact", "Artifact part is too large");
    const content = readFileSync(file, "utf8");
    if (content.length !== part.characters || hash(content) !== part.sha256)
      throw new AppError(
        "invalid_artifact",
        "Artifact part integrity check failed",
      );
    return content;
  }
  read(includeContent = false) {
    const manifest = this.manifest();
    return {
      ...manifest,
      parts: manifest.parts.map((p) => ({
        ...p,
        ...(includeContent ? { content: this.content(p) } : {}),
      })),
    };
  }
  progress() {
    const { parts } = this.manifest();
    return {
      savedParts: parts.length,
      savedChars: parts.reduce((total, p) => total + p.characters, 0),
    };
  }
  assemble() {
    const manifest = this.manifest();
    const ordered = (kind: Part["kind"]) => {
      const parts = manifest.parts
        .filter((p) => p.kind === kind)
        .sort((a, b) => a.index - b.index);
      if (!parts.length || parts.some((p, i) => p.index !== i + 1))
        throw new AppError(
          "incomplete_artifact",
          `Missing or non-contiguous ${kind} parts`,
          422,
        );
      return parts.map((part) => this.content(part));
    };
    const overview = overviewSchema.parse(JSON.parse(ordered("overview")[0]));
    const guide = guideSchema.parse({
      groups: ordered("guide").map((content) => JSON.parse(content)),
    });
    return { ...overview, guide, html: ordered("html").join("") };
  }
}
