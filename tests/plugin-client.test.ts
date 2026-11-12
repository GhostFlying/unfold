import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  stat,
  readdir,
  rm,
  copyFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  clientConfigPath,
  resolveClientOptions,
  configureClient,
  PrepareError,
} from "../plugins/unfold/skills/unfold-review/scripts/prepare.mjs";

const execute = promisify(execFile);
const base = {
  url: "https://code.example.test/team/repo/merge_requests/42",
  head: "a".repeat(40),
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "unfold-client-"));
  const env = {
    XDG_CONFIG_HOME: path.join(root, "config"),
    UNFOLD_HOME: path.join(root, "legacy"),
  };
  const file = clientConfigPath(base, env, root);
  const tokenFile = path.join(root, "owner-key");
  await writeFile(tokenFile, "synthetic-private-key", { mode: 0o600 });
  return {
    root,
    env,
    file,
    tokenFile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("private client binding has explicit/environment/saved precedence and absolute cross-repository references", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.file), { recursive: true });
    await writeFile(
      f.file,
      JSON.stringify({
        version: 1,
        server: "https://saved.example.test",
        tokenFile: f.tokenFile,
        cli: "/private/unfold/bin/unfold.mjs",
      }),
    );
    const saved = resolveClientOptions(base, f.env, f.root);
    assert.equal(saved.server, "https://saved.example.test");
    assert.equal(saved.tokenFile, f.tokenFile);
    assert.equal(saved.cli, "/private/unfold/bin/unfold.mjs");
    const environment = resolveClientOptions(
      base,
      {
        ...f.env,
        UNFOLD_SERVER: "https://environment.example.test/",
        UNFOLD_TOKEN_FILE: "/private/environment-key",
        UNFOLD_CLI: "environment-cli",
      },
      f.root,
    );
    assert.equal(environment.server, "https://environment.example.test");
    assert.equal(environment.tokenFile, "/private/environment-key");
    assert.equal(environment.cli, "environment-cli");
    const explicit = resolveClientOptions(
      {
        ...base,
        server: "https://explicit.example.test",
        cli: "explicit-cli",
        tokenFile: "/private/explicit-key",
      },
      {
        ...f.env,
        UNFOLD_SERVER: environment.server,
        UNFOLD_CLI: environment.cli,
      },
      f.root,
    );
    assert.equal(explicit.server, "https://explicit.example.test");
    assert.equal(explicit.tokenFile, "/private/explicit-key");
    assert.equal(explicit.cli, "explicit-cli");
    assert.equal(
      clientConfigPath(base, { UNFOLD_CLIENT_CONFIG: f.file }, "/another/home"),
      f.file,
    );
    assert.equal(
      clientConfigPath(
        { ...base, clientConfig: "/explicit/client.json" },
        { UNFOLD_CLIENT_CONFIG: f.file },
        f.root,
      ),
      "/explicit/client.json",
    );
  } finally {
    await f.cleanup();
  }
});

test("missing or malformed client configuration fails without guessing localhost and explicit legacy homes remain usable", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => resolveClientOptions(base, f.env, f.root),
      (error: any) =>
        error.code === "client_not_configured" && error.exit === 2,
    );
    await mkdir(path.dirname(f.file), { recursive: true });
    for (const content of [
      "broken json",
      JSON.stringify({
        version: 1,
        server: "https://saved.example.test",
        tokenFile: "relative-key",
      }),
      JSON.stringify({ version: 1, token: "inline-key" }),
    ]) {
      await writeFile(f.file, content);
      assert.throws(
        () => resolveClientOptions(base, f.env, f.root),
        (error: any) => error.code === "invalid_client_config",
      );
    }
    await rm(f.file);
    for (const server of [
      "file:///private/key",
      "https://key:secret@owner.example.test",
      "https://owner.example.test?token=secret",
    ])
      assert.throws(
        () =>
          resolveClientOptions(
            { ...base, server, tokenFile: f.tokenFile },
            f.env,
            f.root,
          ),
        (error: any) => error.code === "invalid_client_config",
      );
    await mkdir(f.env.UNFOLD_HOME, { recursive: true });
    await writeFile(
      path.join(f.env.UNFOLD_HOME, "config.json"),
      JSON.stringify({ ownerBaseUrl: "http://127.0.0.1:12345" }),
    );
    await writeFile(path.join(f.env.UNFOLD_HOME, "owner-token"), "legacy-key");
    const legacy = resolveClientOptions(base, f.env, f.root);
    assert.equal(legacy.server, "http://127.0.0.1:12345");
    assert.equal(legacy.tokenFile, path.join(f.env.UNFOLD_HOME, "owner-token"));
  } finally {
    await f.cleanup();
  }
});

test("configure verifies owner authentication before replacing the binding and stores only protected references", async () => {
  const f = await fixture();
  try {
    const input = resolveClientOptions(
      {
        ...base,
        server: "https://owner.example.test",
        tokenFile: f.tokenFile,
        cli: "/private/cli.mjs",
      },
      f.env,
      f.root,
    );
    const calls: string[][] = [];
    const result = await configureClient(input, async (args) => {
      calls.push(args);
      return [];
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.saved, true);
    assert.deepEqual(calls, [["list"]]);
    assert.equal((await stat(f.file)).mode & 0o777, 0o600);
    const saved = await readFile(f.file, "utf8");
    assert.ok(!saved.includes("synthetic-private-key"));
    assert.equal(JSON.parse(saved).tokenFile, f.tokenFile);
    await assert.rejects(
      configureClient(
        { ...input, server: "https://another.example.test" },
        async () => {
          throw new PrepareError(
            "authentication_required",
            "Not authenticated",
            6,
          );
        },
      ),
      (error: any) => error.exit === 6,
    );
    assert.equal(await readFile(f.file, "utf8"), saved);
    assert.deepEqual(await readdir(path.dirname(f.file)), ["client.json"]);
  } finally {
    await f.cleanup();
  }
});

test("standalone configure/check reuse the saved binding from another repository without ambient Unfold configuration", async () => {
  const f = await fixture();
  try {
    const helper = path.join(f.root, "prepare.mts"),
      cli = path.join(f.root, "fake-cli.mjs");
    await copyFile(
      path.resolve("plugins/unfold/skills/unfold-review/scripts/prepare.mts"),
      helper,
    );
    await writeFile(path.join(f.root, "package.json"), '{"type":"commonjs"}');
    await writeFile(
      cli,
      `const args=process.argv.slice(2);if(!args.includes('list')||args[args.indexOf('--server')+1]!=='https://owner.example.test'||!args.includes('--token-file'))process.exit(9);console.log(JSON.stringify({ok:true,data:[]}));`,
    );
    const env = {
      ...process.env,
      ...f.env,
      UNFOLD_CLIENT_CONFIG: f.file,
      UNFOLD_SERVER: "",
      UNFOLD_TOKEN_FILE: "",
      UNFOLD_CLI: "",
    };
    const configured = await execute(
      process.execPath,
      [
        helper,
        "configure",
        "--server",
        "https://owner.example.test",
        "--token-file",
        f.tokenFile,
        "--cli",
        cli,
      ],
      { cwd: f.root, env },
    );
    assert.equal(JSON.parse(configured.stdout).data.saved, true);
    const repository = path.join(f.root, "another-repo");
    await mkdir(repository);
    const checked = await execute(process.execPath, [helper, "check"], {
      cwd: repository,
      env,
    });
    assert.equal(JSON.parse(checked.stdout).data.authenticated, true);
    assert.equal(JSON.parse(checked.stdout).data.clientConfig, f.file);
    assert.ok(!checked.stdout.includes("synthetic-private-key"));
  } finally {
    await f.cleanup();
  }
});
