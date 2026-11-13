import test from "node:test";
import assert from "node:assert/strict";
import {
  codeownersRules,
  codebaseOwnerConfig,
} from "../src/ownership-rules.js";
import { GitHub } from "../src/github.js";
import { Providers } from "../src/providers.js";
import { AppError, type Snapshot } from "../src/types.js";
import { fixture, snapshot } from "./fixtures.js";

test("CODEOWNERS uses ordered, case-sensitive patterns, directory scope, escaped spaces and explicit clearing", () => {
  const p = codeownersRules(
    `* @global
*.js @js @org/web
/docs/* @docs
/apps/ @apps
/apps/github
**/logs @logs
/space\\ dir/ @spaces
/Case/ @case
!bad @invalid
[abc] @invalid
/literal(name).ts @literal
`,
    ".github/CODEOWNERS",
    "b".repeat(40),
  );
  const owners = (file: string) => p.match(file)?.owners;
  assert.deepEqual(owners("src/index.js"), ["@js", "@org/web"]);
  assert.deepEqual(owners("docs/readme.md"), ["@docs"]);
  assert.deepEqual(owners("docs/nested/readme.md"), ["@global"]);
  assert.deepEqual(owners("apps/index.ts"), ["@apps"]);
  assert.deepEqual(owners("apps/github/x.ts"), []);
  assert.deepEqual(owners("deep/logs/build.log"), ["@logs"]);
  assert.deepEqual(owners("space dir/file.ts"), ["@spaces"]);
  assert.deepEqual(owners("Case/file.ts"), ["@case"]);
  assert.deepEqual(owners("case/file.ts"), ["@global"]);
  assert.deepEqual(owners("literal(name).ts"), ["@literal"]);
  assert.deepEqual(owners("literalname.ts"), ["@global"]);
  assert.equal(p.warnings.length, 2);
  assert.throws(() => p.match("../secret"));
  assert.deepEqual(
    codeownersRules("/unowned # intentional\n", "CODEOWNERS", "b").match(
      "unowned/file",
    )?.owners,
    [],
  );
});

test("pinned GitHub target CODEOWNERS has location precedence and does not read fork/head rules", async () => {
  const gh = new GitHub(),
    calls: string[] = [];
  const s: Snapshot = {
    ...snapshot,
    targetHead: "c".repeat(40),
    target: {
      provider: "github",
      host: "github.com",
      repo: "example/repo",
      number: 42,
      url: "https://github.com/example/repo/pull/42",
    },
  };
  gh.source = async (pin, file, side) => {
    assert.equal(pin.head, s.targetHead);
    assert.equal(side, "new");
    calls.push(file);
    return {
      id: "rule",
      versionId: s.id,
      path: file,
      side,
      commit: pin.head,
      content: file === ".github/CODEOWNERS" ? "/src/ @runtime\n" : "* @wrong",
    };
  };
  const result = await gh.ownership(s);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, [".github/CODEOWNERS"]);
  assert.ok(result.files.every((f) => f.owners[0] === "@runtime"));
  assert.ok(result.rules.every((r) => r.revision === s.targetHead));
  let changed = false;
  gh.api = async (endpoint) =>
    endpoint.includes("/compare/")
      ? {
          merge_base_commit: { sha: s.base },
          base_commit: { sha: s.targetHead },
        }
      : {
          head: { sha: changed ? "f".repeat(40) : s.head },
          base: { sha: s.targetHead },
        };
  const legacySnapshot = { ...s, targetHead: undefined };
  const recovered = await gh.ownership(legacySnapshot);
  assert.equal(recovered.status, "complete");
  assert.equal(legacySnapshot.targetHead, undefined);
  assert.ok(recovered.rules.every((r) => r.revision === s.targetHead));
  changed = true;
  assert.equal((await gh.ownership(legacySnapshot)).status, "unavailable");
  gh.source = async () => {
    throw new AppError("source_not_found", "Missing", 404);
  };
  assert.equal((await gh.ownership(s)).files[0].status, "unowned");
  gh.source = async () => {
    throw new AppError("github_auth_required", "Login", 401);
  };
  assert.equal((await gh.ownership(s)).status, "unavailable");
});

test("Codebase uses effective owner rules with pinned no_parent inheritance and rejects unsupported conditions or head races", async () => {
  const f = fixture(),
    p = new Providers(f.service.config);
  let noParent = true,
    unsupported = false,
    changed = false;
  const rules = [
    {
      Name: "OWNERS",
      ApprovalsRequired: 1,
      ReviewerSelectors: [{ User: { Username: "root-owner" } }],
    },
    {
      Name: "src/OWNERS",
      ApprovalsRequired: 1,
      ReviewerSelectors: [{ User: { Username: "src-owner" } }],
    },
  ];
  p.byted = async (args) => {
    if (args[2] === "status")
      return {
        merge_request: { source_commit_id: snapshot.head },
        review: {
          review_rule_groups: [{ Type: "owner_review", ReviewRules: rules }],
        },
      };
    if (args[2] === "get")
      return {
        version: { SourceCommitId: changed ? "f".repeat(40) : snapshot.head },
      };
    const file = args[3];
    if (file === ".")
      return {
        file: {
          DirEntries: [
            { Name: "src", Path: "src", Type: "directory" },
            { Name: "OWNERS", Path: "OWNERS", Type: "file" },
          ],
        },
      };
    if (file === "src")
      return {
        file: {
          DirEntries: [
            { Name: "queue.ts", Path: "src/queue.ts", Type: "file" },
            { Name: "OWNERS", Path: "src/OWNERS", Type: "file" },
          ],
        },
      };
    return {
      file: {
        Content: `reviewers:\n  - reader\nno_parent: ${file === "src/OWNERS" && noParent}\n${unsupported ? "filters: unknown\n" : ""}`,
      },
    };
  };
  try {
    let result = await p.ownership(snapshot);
    assert.equal(result.status, "complete");
    assert.equal(result.files.length, 2);
    assert.deepEqual(result.files[0].owners, ["src-owner"]);
    noParent = false;
    result = await p.ownership(snapshot);
    assert.deepEqual(result.files[0].owners, ["root-owner", "src-owner"]);
    unsupported = true;
    result = await p.ownership(snapshot);
    assert.equal(result.status, "partial");
    assert.ok(result.files.every((b) => b.status === "unknown"));
    unsupported = false;
    rules.push({ ...rules[0] });
    assert.equal((await p.ownership(snapshot)).status, "unavailable");
    rules.pop();
    rules[0].ReviewerSelectors.push({} as any);
    assert.equal((await p.ownership(snapshot)).status, "unavailable");
    rules[0].ReviewerSelectors.pop();
    changed = true;
    assert.equal((await p.ownership(snapshot)).status, "unavailable");
  } finally {
    f.cleanup();
  }
});

test("OWNERS parsing never silently ignores unsupported or aliased ownership conditions", () => {
  assert.deepEqual(
    codebaseOwnerConfig("reviewers: [reader]\nno_parent: true"),
    { noParent: true },
  );
  for (const source of [
    "reviewers: [reader]\nfilter: '*.cc'",
    "reviewers: [reader]\nno_parent: yes",
    "reviewers: [{team: all}]",
    "reviewers: &people [reader]\nno_parent: *people",
  ])
    assert.throws(() => codebaseOwnerConfig(source));
});
