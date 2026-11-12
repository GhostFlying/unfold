import {
  AppError,
  type FileDiff,
  type Reference,
  type Snapshot,
} from "./types.js";
export interface DiffLine {
  kind: "context" | "add" | "delete" | "header";
  text: string;
  old?: number;
  new?: number;
}
export function diffLines(patch: string): DiffLine[] {
  let old = 0,
    fresh = 0,
    inHunk = false;
  return patch.split("\n").map((text) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (m) {
      old = +m[1];
      fresh = +m[2];
      inHunk = true;
      return { kind: "header", text };
    }
    if (!inHunk || ![" ", "+", "-"].includes(text[0]))
      return { kind: "header", text };
    if (text[0] === "+")
      return { kind: "add", text: text.slice(1), new: fresh++ };
    if (text[0] === "-")
      return { kind: "delete", text: text.slice(1), old: old++ };
    return { kind: "context", text: text.slice(1), old: old++, new: fresh++ };
  });
}
export function validateAnchor(s: Snapshot, anchor: Reference) {
  if (anchor.commit !== (anchor.side === "new" ? s.head : s.base))
    throw new AppError(
      "stale_anchor",
      "Reference commit does not match this version",
      409,
    );
  const f = s.files.find(
    (f) => (anchor.side === "old" ? f.oldPath : f.path) === anchor.path,
  );
  if (!f || f.binary || f.truncated)
    throw new AppError(
      "unmappable_anchor",
      "This location cannot be mapped reliably; explicitly choose a general comment",
      409,
    );
  const lines = diffLines(f.patch);
  for (let n = anchor.start; n <= anchor.end; n++)
    if (!lines.some((l) => l[anchor.side] === n))
      throw new AppError(
        "unmappable_anchor",
        "Selected lines are outside the current diff; explicitly choose a general comment",
        409,
      );
}
