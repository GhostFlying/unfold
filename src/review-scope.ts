import {
  AppError,
  type Explanation,
  type Snapshot,
  type ChangeGroup,
} from "./types.js";

export type ReviewScope = { owner?: string; path?: string };
export function scopePath(value: string) {
  const p = value.replace(/\/$/, "");
  if (
    !p ||
    p.length > 2048 ||
    p.startsWith("-") ||
    p.startsWith("/") ||
    p.includes("\\") ||
    p.includes("\0") ||
    p.split("/").some((s) => !s || s === "." || s === ".." || s === ".git")
  )
    throw new AppError(
      "invalid_scope",
      "Use a repository-relative path without traversal",
    );
  return p;
}
export function projectGuide(
  explanation: Pick<
    Explanation,
    "guide" | "ownership" | "summary" | "references"
  >,
  snapshot: Snapshot,
  input: ReviewScope = {},
) {
  if (!explanation.guide)
    throw new AppError(
      "guide_unavailable",
      "This explanation has no logical guide",
      404,
    );
  if (
    (input.owner !== undefined &&
      (typeof input.owner !== "string" ||
        !input.owner ||
        input.owner.length > 300)) ||
    (input.path !== undefined && typeof input.path !== "string") ||
    (input.owner && input.path)
  )
    throw new AppError("invalid_scope", "Select one owner or one path");
  const ownership = explanation.ownership;
  if (ownership && ownership.versionId !== snapshot.id)
    throw new AppError(
      "invalid_scope",
      "Ownership belongs to another source version",
      409,
    );
  const owners = [
    ...new Set(ownership?.files.flatMap((f) => f.owners) || []),
  ].sort();
  const owner = input.owner
    ? owners.find((o) => o.toLowerCase() === input.owner!.toLowerCase())
    : undefined;
  if (input.owner && !ownership)
    throw new AppError(
      "ownership_unavailable",
      "This historical explanation has no saved ownership; select a path",
      404,
    );
  if (input.owner && !owner)
    throw new AppError(
      "scope_not_found",
      "Owner has no resolved changed files in this explanation",
      404,
    );
  const p = input.path ? scopePath(input.path) : undefined;
  const hasScope = !!(owner || p),
    selected = new Set<string>();
  for (const file of snapshot.files) {
    const paths = [file.path, file.oldPath];
    if (!hasScope) paths.forEach((x) => selected.add(x));
    else if (p) {
      if (paths.some((x) => x === p || x.startsWith(p + "/")))
        paths.forEach((x) => selected.add(x));
    } else
      for (const binding of ownership!.files)
        if (
          (binding.side === "old" ? file.oldPath : file.path) ===
            binding.path &&
          binding.owners.includes(owner!)
        )
          paths.forEach((x) => selected.add(x));
  }
  const all = explanation.guide.groups;
  const groups = all.flatMap((g) => {
    const points = g.points.filter((point) =>
      point.files.some((f) => selected.has(f)),
    );
    return points.length
      ? [
          {
            ...g,
            points: points.map((point) => ({
              ...point,
              focusFiles: point.files.filter((f) => selected.has(f)),
            })),
          },
        ]
      : [];
  });
  const contextGroups: {
    group: ChangeGroup;
    reasons: { from: string; reason: string; referenceIds: string[] }[];
  }[] = [];
  if (hasScope) {
    const visited = new Set(groups.map((g) => g.id)),
      pending = [...groups];
    for (let i = 0; i < pending.length; i++)
      for (const link of pending[i].context || []) {
        const target = all[link.group - 1];
        if (!target) continue;
        const direct = groups.find((g) => g.id === target.id);
        if (!direct || direct.points.length < target.points.length) {
          let entry = contextGroups.find((c) => c.group.id === target.id);
          if (!entry) {
            entry = { group: target, reasons: [] };
            contextGroups.push(entry);
          }
          if (!entry.reasons.some((r) => r.from === pending[i].id))
            entry.reasons.push({
              from: pending[i].id,
              reason: link.reason,
              referenceIds: link.referenceIds,
            });
        }
        if (!visited.has(target.id)) {
          visited.add(target.id);
          pending.push(target as (typeof pending)[number]);
        }
      }
  }
  const refs = new Set([
    ...groups.flatMap((g) => [
      ...g.points.flatMap((point) => point.referenceIds),
      ...(g.context || []).flatMap((c) => c.referenceIds),
    ]),
    ...contextGroups.flatMap((c) => [
      ...c.reasons.flatMap((r) => r.referenceIds),
      ...c.group.points.flatMap((point) => point.referenceIds),
      ...(c.group.context || []).flatMap((link) => link.referenceIds),
    ]),
  ]);
  return {
    summary: explanation.summary,
    scope: { owner, path: p },
    owners,
    focusFiles: [...selected].sort(),
    groups,
    contextGroups,
    modular: all.every(
      (g) => !!g.responsibility && !!g.reviewFocus && !!g.context,
    ),
    ownership: ownership
      ? {
          status: ownership.status,
          provider: ownership.provider,
          capturedAt: ownership.capturedAt,
          rules: ownership.rules,
          warnings: ownership.warnings,
          unknownFiles: ownership.files
            .filter((f) => f.status === "unknown")
            .map((f) => `${f.side}:${f.path}`),
        }
      : null,
    references: explanation.references.filter((r) => refs.has(r.id)),
  };
}
