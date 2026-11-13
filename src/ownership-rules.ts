import path from "node:path";
import picomatch from "picomatch";
import { parse } from "yaml";
import {
  AppError,
  type Ownership,
  type OwnershipRule,
  type Snapshot,
} from "./types.js";
import { hash, now, safePath } from "./util.js";

export function unavailableOwnership(s: Snapshot, message: string): Ownership {
  return {
    versionId: s.id,
    provider: s.target.provider,
    capturedAt: now(),
    status: "unavailable",
    rules: [],
    files: [],
    warnings: [message],
  };
}

export function codebaseOwnerConfig(text: string): { noParent: boolean } {
  if (Buffer.byteLength(text) > 65536)
    throw new AppError(
      "ownership_unsupported",
      "OWNERS file exceeds the supported size",
    );
  const data = parse(text, { maxAliasCount: 0, uniqueKeys: true });
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some(
      (k) => !["reviewers", "approvals_required", "no_parent"].includes(k),
    ) ||
    (data.no_parent !== undefined && typeof data.no_parent !== "boolean") ||
    !Array.isArray(data.reviewers) ||
    data.reviewers.some((r: unknown) => typeof r !== "string") ||
    (data.approvals_required !== undefined &&
      (!Number.isSafeInteger(data.approvals_required) ||
        data.approvals_required < 0))
  )
    throw new AppError(
      "ownership_unsupported",
      "OWNERS uses unsupported conditions; file ownership remains unknown",
    );
  return { noParent: data.no_parent === true };
}

export function codeownersRules(text: string, file: string, revision: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 20000)
    throw new AppError(
      "ownership_unsupported",
      "CODEOWNERS has too many rules",
    );
  const warnings: string[] = [];
  const compiled: {
    rule: OwnershipRule;
    matches: (value: string) => boolean;
  }[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.match(/(?:\\.|[^\s])+/g) || [];
    const pattern = tokens[0];
    if (
      !pattern ||
      pattern.length > 1024 ||
      pattern.startsWith("!") ||
      pattern.startsWith("\\#") ||
      /[\[\]]/.test(pattern) ||
      pattern.includes("\0")
    ) {
      warnings.push(`Ignored invalid CODEOWNERS pattern at line ${index + 1}`);
      continue;
    }
    const comment = tokens.findIndex((t, i) => i > 0 && t.startsWith("#"));
    const owners = tokens.slice(1, comment < 0 ? undefined : comment);
    if (
      owners.some(
        (o) =>
          !/^@[a-z\d-]+(?:\/[a-z\d_.-]+)?$/i.test(o) &&
          !/^[^\s@]+@[^\s@]+$/.test(o),
      )
    ) {
      warnings.push(`Ignored invalid CODEOWNERS owner at line ${index + 1}`);
      continue;
    }
    let glob = pattern.replace(/^\//, "");
    if (glob.split("/").some((p) => p === ".." || p === ".git")) {
      warnings.push(`Ignored unsafe CODEOWNERS pattern at line ${index + 1}`);
      continue;
    }
    const directory = glob.endsWith("/");
    if (!pattern.startsWith("/") && !glob.replace(/\/$/, "").includes("/"))
      glob = `**/${glob}`;
    if (directory) glob += "**";
    // CODEOWNERS has no regexp/extended-glob parentheses.
    const match = picomatch(glob.replace(/[()|]/g, "\\$&"), {
      dot: true,
      nocase: false,
      nobrace: true,
      noext: true,
      nonegate: true,
      strictSlashes: true,
    });
    const literalEnd = !directory && !/[*?]/.test(pattern.split("/").at(-1)!);
    const rule: OwnershipRule = {
      id: hash(`${file}:${revision}:${index + 1}`).slice(0, 24),
      path: file,
      revision,
      pattern,
      line: index + 1,
      owners,
    };
    compiled.push({
      rule,
      matches: (value) =>
        match(value) ||
        (literalEnd &&
          value
            .split("/")
            .slice(0, -1)
            .some((_, i) =>
              match(
                value
                  .split("/")
                  .slice(0, i + 1)
                  .join("/"),
              ),
            )),
    });
  }
  return {
    rules: compiled.map((c) => c.rule),
    warnings,
    match(value: string) {
      safePath(value);
      for (let i = compiled.length - 1; i >= 0; i--)
        if (compiled[i].matches(value)) return compiled[i].rule;
      return undefined;
    },
  };
}

export function ancestorDirectories(file: string) {
  safePath(file);
  const dirs: string[] = [];
  let current = path.posix.dirname(file);
  while (true) {
    dirs.push(current);
    if (current === ".") break;
    current = path.posix.dirname(current);
  }
  return dirs;
}
