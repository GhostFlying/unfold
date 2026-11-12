import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readlink,
  lstat,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startConnector } from "../src/connector.js";
import { saveConfig, secret } from "../src/config.js";
import { connectorRequest } from "../src/rpc.js";
import { updateAuthLink } from "../src/agent.js";
import { testConfig } from "./fixtures.js";

// Synthetic native protocol peer: no reviewed project or real credentials.
const peer = `#!/usr/bin/env node
const {createInterface}=require('node:readline');
if(process.argv.includes('--version')){console.log('synthetic-agent 1');process.exit(0)}
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='account/read')result={account:{type:'synthetic-owner'}};
if(m.method==='model/list')result={data:[{id:'test-model',model:'test-model',displayName:'Test Model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:''}]}],nextCursor:null};
console.log(JSON.stringify({id:m.id,result}))});`;

test("connector reload checks real stdio readiness, applies auth changes, and keeps failures explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-connector-test-"));
  process.env.UNFOLD_HOME = root;
  const cfg = testConfig(root);
  const executable = path.join(root, "native-peer.cjs");
  const original = path.join(root, "original-auth.json"),
    replacement = path.join(root, "replacement-auth.json");
  await writeFile(executable, peer, { mode: 0o700 });
  await writeFile(original, '{"synthetic":1}', { mode: 0o600 });
  await writeFile(replacement, '{"synthetic":2}', { mode: 0o600 });
  cfg.agents.traex = { executable, authFile: original, model: "test-model" };
  cfg.agents.codex = { ...cfg.agents.traex };
  saveConfig(cfg);
  const app = await startConnector(cfg);
  const token = secret(root, "connector-token");
  const rpc = <T = any>(method: string, params: unknown = {}) =>
    connectorRequest<T>(cfg.socketPath, token, method, params);
  try {
    await rpc("models", { backend: "traex" });
    const authDest = path.join(root, "agents/traex/cli/auth.json");
    assert.equal(await readlink(authDest), original);
    cfg.agents.traex.authFile = replacement;
    saveConfig(cfg);
    assert.equal((await rpc("reload_config")).state, "applied");
    await rpc("models", { backend: "traex" });
    assert.equal(await readlink(authDest), replacement);
    cfg.agents.traex.executable = path.join(root, "missing-agent");
    saveConfig(cfg);
    const failed = await rpc("reload_config");
    assert.equal(failed.state, "failed");
    assert.notEqual(failed.appliedRevision, failed.desiredRevision);
    await assert.rejects(rpc("models", { backend: "traex" }), /failed/);
    await assert.rejects(
      connectorRequest(cfg.socketPath, "wrong-key", "reload_config", {}),
      /authentication required/i,
    );
    cfg.agents.traex.executable = executable;
    saveConfig(cfg);
    assert.equal((await rpc("reload_config")).state, "applied");
    assert.ok((await lstat(authDest)).isSymbolicLink());
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed authentication links replace dangling targets and never overwrite an unmanaged file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-authlink-test-"));
  try {
    const auth = path.join(root, "source.json"),
      dest = path.join(root, "auth.json");
    await writeFile(auth, "{}", { mode: 0o600 });
    await symlink(path.join(root, "gone.json"), dest);
    updateAuthLink(auth, dest, "codex");
    assert.equal(await readlink(dest), auth);
    await rm(dest);
    await writeFile(dest, '{"unmanaged":true}');
    assert.throws(() => updateAuthLink(auth, dest, "codex"), /unmanaged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
