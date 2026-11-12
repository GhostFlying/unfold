import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  readlink,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { executeApproved } from "../src/execution.js";
import { Providers } from "../src/providers.js";
import { snapshot, testConfig } from "./fixtures.js";

test("approved execution sees a disposable snapshot, no owner files/environment, and no host network", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-execution-"));
  const ownerSecret = path.join(root, "owner-credential");
  await writeFile(ownerSecret, "synthetic-owner-secret");
  const providers = new Providers(testConfig(root));
  providers.tree = async () => [
    { path: "reviewed.txt", name: "reviewed.txt", type: "file", size: 8 },
  ];
  providers.source = async () => ({
    id: "synthetic-source",
    versionId: snapshot.id,
    path: "reviewed.txt",
    side: "new",
    commit: snapshot.head,
    content: "original",
  });
  process.env.UNFOLD_SYNTHETIC_CREDENTIAL = "must-not-be-visible";
  const hostNetwork = await readlink("/proc/self/ns/net");
  try {
    const request = {
      command: `test "$(readlink /proc/self/ns/net)" != '${hostNetwork}' && test ! -e '${ownerSecret}' && test -z "$UNFOLD_SYNTHETIC_CREDENTIAL" && test "$(cat reviewed.txt)" = original && echo changed > reviewed.txt && test ! -e "$HOME/.codex/auth.json" && test -z "$(ls /sys/class/net 2>/dev/null)" && echo isolated`,
      cwd: ".",
      purpose: "Synthetic isolation test",
      sideEffects: "Writes the disposable fixture only",
      network: false,
      timeoutSeconds: 10,
    };
    const result = await executeApproved(
      root,
      providers,
      snapshot,
      request,
      new AbortController().signal,
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), "isolated");
    assert.equal(await readFile(ownerSecret, "utf8"), "synthetic-owner-secret");
    assert.deepEqual(await readdir(path.join(root, "executions")), []);
  } finally {
    delete process.env.UNFOLD_SYNTHETIC_CREDENTIAL;
    await rm(root, { recursive: true, force: true });
  }
});
