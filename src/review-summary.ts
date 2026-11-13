import {
  AppError,
  type Explanation,
  type Review,
  type Snapshot,
} from "./types.js";
import { guidePaths } from "./review-scope.js";

function clean(value: string) {
  return value
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/[^\s<>]+/gi, "")
    .replace(/`|\*\*/g, "")
    .replace(/\s+/gu, " ")
    .trim();
}
function brief(value: string, limit: number) {
  const chars = Array.from(clean(value));
  if (chars.length <= limit) return chars.join("");
  let head = chars.slice(0, limit - 1).join("");
  const sentenceEnd = Math.max(
    ...["。", "！", "？"].map((c) => head.lastIndexOf(c)),
  );
  if (sentenceEnd >= limit * 0.4) return head.slice(0, sentenceEnd + 1);
  const boundary = Math.max(
    ...["。", "；", "，", ";", ",", " "].map((c) => head.lastIndexOf(c)),
  );
  if (boundary >= head.length * 0.65) head = head.slice(0, boundary);
  return head.trimEnd() + "…";
}
const within = (file: string, directory: string) =>
  file === directory || file.startsWith(directory + "/");

export function reviewSummary(
  review: Pick<Review, "id" | "target" | "versionId">,
  snapshot: Snapshot,
  explanation: Omit<Explanation, "threadId">,
  url: string,
) {
  if (
    explanation.reviewId !== review.id ||
    explanation.versionId !== snapshot.id ||
    (explanation.ownership && explanation.ownership.versionId !== snapshot.id)
  )
    throw new AppError(
      "version_mismatch",
      "Summary data belongs to another source version",
      409,
    );
  const points = explanation.guide?.groups.flatMap((g) => g.points) || [];
  const sections = points.length
    ? guidePaths(snapshot, explanation.ownership).map((option) => {
        const files = snapshot.files.filter(
          (f) => within(f.path, option.path) || within(f.oldPath, option.path),
        );
        const aliases = new Set(files.flatMap((f) => [f.path, f.oldPath]));
        const direct = points.filter((p) =>
          p.files.some((f) => aliases.has(f)),
        );
        const bindings =
          explanation.ownership?.files.filter((b) =>
            within(b.path, option.path),
          ) || [];
        const owners = [
          ...new Set(
            bindings
              .filter((b) => b.status === "resolved")
              .flatMap((b) => b.owners),
          ),
        ].sort();
        const unknown =
          bindings.some((b) => b.status === "unknown") ||
          files.some(
            (f) =>
              !bindings.some((b) => b.path === f.path || b.path === f.oldPath),
          );
        const ownershipStatus = unknown
          ? owners.length
            ? "partial"
            : "unknown"
          : owners.length
            ? "resolved"
            : "unowned";
        const titles = [...new Set(direct.map((p) => clean(p.title)))];
        return {
          path: option.path,
          label: option.label,
          owners,
          ownershipStatus,
          summary:
            titles.join("；") || `${files.length} 个文件修改，详见完整讲解`,
          pointIds: direct.map((p) => p.id),
          otherPoints: 0,
        };
      })
    : [];
  const overview = brief(explanation.summary || explanation.title, 110);
  const stale = review.versionId !== snapshot.id;
  const lines = sections.map((section) => {
    const owners = section.owners
      .slice(0, 4)
      .map((o) => {
        const name = clean(o);
        return name.startsWith("@") ? name : `@${name}`;
      })
      .join(" ");
    const remaining =
      section.owners.length > 4 ? ` 等${section.owners.length}位` : "";
    const unknown =
      section.ownershipStatus === "partial" ? "（部分 owner 待确认）" : "";
    const ownerLabel =
      owners + remaining + unknown ||
      (section.ownershipStatus === "unowned" ? "未配置 owner" : "owner 待确认");
    return `${ownerLabel} · ${brief(section.label, 80)}：${section.summary}`;
  });
  const omittedPaths = 0;
  if (!sections.length) lines.push("路径摘要尚未生成。");
  return {
    reviewId: review.id,
    explanationId: explanation.id,
    versionId: snapshot.id,
    head: snapshot.head,
    sourceUrl: review.target.url,
    url,
    stale,
    overview,
    sections,
    omittedPaths,
    mentions: "plain-text" as const,
    text: [
      overview,
      ...(stale
        ? [
            `注意：讲解对应旧提交 ${snapshot.head.slice(0, 8)}，原 MR/PR 已有新版本。`,
          ]
        : []),
      "",
      ...lines,
      "",
      `完整讲解（${snapshot.head.slice(0, 8)}）：${url}`,
    ].join("\n"),
  };
}
