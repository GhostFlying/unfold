import test from "node:test";
import assert from "node:assert/strict";
import { Providers } from "../src/providers.js";
import { fixture, snapshot, target } from "./fixtures.js";

test("Codebase preserves the inherited base separately from the parent MR's observed head", async () => {
  const f = fixture();
  try {
    const parentChangeId = "I" + "1".repeat(40);
    const changeId = "I" + "2".repeat(40);
    const updatedParentHead = "c".repeat(40);
    const childHead = "d".repeat(40);
    const parent = { Id: "app-parent", Number: 41, ChangeId: parentChangeId };
    const child = {
      Id: "app-child",
      Number: 43,
      ParentMergeRequestId: "app-current",
    };
    const providers = new Providers(f.service.config);
    let commitAvailable = true;
    providers.byted = async (args) => {
      const operation = args.slice(0, 3).join(" ");
      if (operation === "codebase mr get") {
        if (args[3] === "41")
          return {
            merge_request: parent,
            version: { Number: 9, SourceCommitId: updatedParentHead },
          };
        if (args[3] === "43")
          return {
            merge_request: child,
            version: { Number: 4, SourceCommitId: childHead },
          };
        return {
          repository: { id: "repo-1" },
          merge_request: {
            Id: "app-current",
            ParentMergeRequestId: parent.Id,
            TargetBranchName: "develop",
          },
          version: {
            Number: 3,
            SourceCommitId: snapshot.head,
            BaseCommitId: snapshot.base,
          },
        };
      }
      if (operation === "codebase commit get") {
        assert.equal(args[4], snapshot.head);
        if (!commitAvailable) throw new Error("commit unavailable");
        return {
          commit: {
            Id: snapshot.head,
            Message: `Subject\n\n[internal]\nLynxstack-Change-Id: ${changeId}\nLynxstack-Parent-Change-Id: ${parentChangeId}\n[end-internal]\n`,
          },
        };
      }
      if (operation === "codebase mr list") {
        assert.ok([snapshot.head, snapshot.base].includes(args[4]));
        return {
          total_count: 1,
          merge_requests: [args[4] === snapshot.base ? parent : child],
        };
      }
      if (operation === "codebase mr diff")
        return { range: { from: snapshot.base, to: snapshot.head }, files: [] };
      assert.equal(operation, "codebase mr comment");
      return { threads: [] };
    };
    const current = await providers.snapshot(target);
    assert.equal(current.base, snapshot.base);
    assert.equal(current.head, snapshot.head);
    assert.deepEqual(current.stackContext, {
      source: "lynxstack",
      status: "confirmed",
      targetBranch: "develop",
      changeId,
      parent: {
        number: 41,
        url: "https://code.example.test/sample/queue/merge_requests/41",
        head: updatedParentHead,
        changeId: parentChangeId,
        remoteVersion: "9",
      },
      child: {
        number: 43,
        url: "https://code.example.test/sample/queue/merge_requests/43",
        head: childHead,
        changeId: undefined,
        remoteVersion: "4",
      },
    });
    commitAvailable = false;
    const fallback = await providers.snapshot(target);
    assert.equal(fallback.id, current.id);
    assert.equal(fallback.stackContext?.source, "codebase");
  } finally {
    f.cleanup();
  }
});
