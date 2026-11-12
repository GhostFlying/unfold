import { z } from "zod";
import {
  AppError,
  type ChangeGuide,
  type Reference,
  type Snapshot,
} from "./types.js";
const text = z.string().trim().min(1).max(6000);
export const guideSchema = z.object({
  groups: z
    .array(
      z.object({
        title: text,
        category: z.string().trim().min(1).max(80),
        summary: text,
        points: z
          .array(
            z.object({
              title: text,
              summary: text,
              before: text,
              after: text,
              rationale: text,
              risks: z.array(text).max(16),
              files: z.array(z.string().min(1).max(1000)).min(1).max(100),
              referenceIds: z.array(z.string().min(1).max(80)).max(100),
            }),
          )
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(16),
});
// Derive stable point IDs inside each immutable explanation. All model-provided
// file names and references must resolve against this exact investigation.
export function validateGuide(
  value: unknown,
  snapshot: Snapshot,
  references: Reference[],
): ChangeGuide {
  const guide = guideSchema.parse(value);
  const files = new Set(snapshot.files.flatMap((f) => [f.path, f.oldPath]));
  const refIds = new Set(references.map((r) => r.id));
  const covered = new Set<string>();
  let pointCount = 0;
  const groups = guide.groups.map((group, g) => ({
    ...group,
    id: `g${g + 1}`,
    points: group.points.map((point, c) => {
      if (++pointCount > 128)
        throw new AppError(
          "invalid_guide",
          "Guide has too many change points",
          422,
        );
      if (
        point.files.some((f) => !files.has(f)) ||
        point.referenceIds.some((r) => !refIds.has(r))
      )
        throw new AppError(
          "invalid_guide",
          "Guide contains an unverified file or source reference",
          422,
        );
      point.files.forEach((f) => covered.add(f));
      return { ...point, id: `g${g + 1}-c${c + 1}` };
    }),
  }));
  if (
    snapshot.files.some((f) => !covered.has(f.path) && !covered.has(f.oldPath))
  )
    throw new AppError(
      "invalid_guide",
      "Guide does not account for all changed files",
      422,
    );
  return { groups };
}
