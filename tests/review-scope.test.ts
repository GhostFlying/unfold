import test from "node:test";
import assert from "node:assert/strict";
import { projectGuide, guidePaths } from "../src/review-scope.js";
import { validateGuide } from "../src/guide.js";
import { createServer } from "../src/server.js";
import { secret } from "../src/config.js";
import { fixture, seed } from "./fixtures.js";
import type { Ownership } from "../src/types.js";

async function scopeFixture() {
  const f = fixture(),
    { review, explanation } = await seed(f.service);
  const version = f.service.version(review.id);
  version.files.push({
    ...version.files[0],
    path: "shared/contract.ts",
    oldPath: "old/contract.ts",
  });
  f.service.store.put("version", version);
  const g = explanation.guide!.groups;
  g[1].points[0].files = ["shared/contract.ts"];
  g[1].points[0].title = "共享接口约定";
  g.forEach((m, i) => {
    m.responsibility = i ? "规定回调约定" : "处理任务取消";
    m.reviewFocus = [i ? "检查调用约定" : "检查资源释放"];
    m.context = i
      ? []
      : [
          {
            group: 2,
            reason: "资源释放依赖共享接口的新约定",
            referenceIds: [explanation.references[0].id],
          },
        ];
  });
  const ownership: Ownership = {
    versionId: version.id,
    provider: "codebase",
    capturedAt: new Date().toISOString(),
    status: "complete",
    rules: [],
    files: [
      {
        path: "src/queue.ts",
        side: "new",
        owners: ["runtime"],
        ruleIds: [],
        status: "resolved",
      },
      {
        path: "shared/contract.ts",
        side: "new",
        owners: ["contracts"],
        ruleIds: [],
        status: "resolved",
      },
      {
        path: "old/contract.ts",
        side: "old",
        owners: ["previous"],
        ruleIds: [],
        status: "resolved",
      },
    ],
    warnings: [],
  };
  explanation.ownership = ownership;
  f.service.store.put("explanation", explanation);
  return { ...f, review, explanation, version, ownership };
}

test("path suggestions use saved rule directories and literal CODEOWNERS prefixes without people or glob labels", async () => {
  const f = await scopeFixture();
  try {
    f.ownership.rules = ["src", "shared", "unused"].map((p, i) => ({
      id: `r${i}`,
      path: `${p}/OWNERS`,
      revision: f.version.head,
      owners: ["person-name"],
    }));
    assert.deepEqual(guidePaths(f.version, f.ownership), [
      { path: "old", label: "old/", fileCount: 1 },
      { path: "shared", label: "shared/", fileCount: 1 },
      { path: "src", label: "src/", fileCount: 1 },
    ]);
    assert.equal(guidePaths(f.version).length, 3);
    f.ownership.provider = "github";
    f.ownership.rules = [
      {
        id: "r0",
        path: ".github/CODEOWNERS",
        pattern: "/src/**",
        revision: f.version.head,
        owners: ["@person-name"],
      },
      {
        id: "r1",
        path: ".github/CODEOWNERS",
        pattern: "/shared/contract.ts",
        revision: f.version.head,
        owners: ["@person-name"],
      },
    ];
    f.ownership.files[0].ruleIds = ["r0"];
    f.ownership.files[1].ruleIds = ["r1"];
    const paths = guidePaths(f.version, f.ownership);
    assert.deepEqual(
      paths.map((p) => p.path),
      ["old", "shared/contract.ts", "src"],
    );
    assert.ok(!JSON.stringify(paths).includes("person-name"));
    assert.ok(!JSON.stringify(paths).includes("**"));
    const api = await createServer(f.service, false);
    f.service.store.put("explanation", f.explanation);
    try {
      const guide = (
        await api.inject(`/api/v1/reviews/${f.review.id}/guide?path=src`)
      ).json().data;
      assert.deepEqual(guide.paths, paths);
      const linked = (
        await api.inject(`/api/v1/reviews/${f.review.id}/share?path=src`)
      ).json().data.url;
      assert.ok(linked.includes(`/v/${f.explanation.id}?path=src`));
    } finally {
      await api.close();
    }
  } finally {
    f.cleanup();
  }
});

test("module output validates evidence, module numbering and required new fields while legacy guides remain readable", async () => {
  const f = await scopeFixture();
  try {
    assert.equal(
      validateGuide(
        f.explanation.guide,
        f.version,
        f.explanation.references,
        true,
      ).groups.length,
      2,
    );
    for (const group of [0, 1, 3]) {
      const guide = structuredClone(f.explanation.guide!);
      guide.groups[0].context![0].group = group;
      assert.throws(() =>
        validateGuide(guide, f.version, f.explanation.references, true),
      );
    }
    const invalid = structuredClone(f.explanation.guide!);
    invalid.groups[0].context![0].referenceIds = ["invented"];
    assert.throws(() =>
      validateGuide(invalid, f.version, f.explanation.references, true),
    );
    const old = structuredClone(f.explanation.guide!);
    delete old.groups[0].responsibility;
    assert.throws(() =>
      validateGuide(old, f.version, f.explanation.references, true),
    );
    assert.equal(
      validateGuide(old, f.version, f.explanation.references).groups.length,
      2,
    );
  } finally {
    f.cleanup();
  }
});

test("owner/path projections keep global background, complete points and transitive context without cycles or rename loss", async () => {
  const f = await scopeFixture();
  try {
    const v = projectGuide(f.explanation, f.version, { owner: "runtime" });
    assert.equal(v.summary, f.explanation.summary);
    assert.equal(v.groups.length, 1);
    assert.equal(v.contextGroups.length, 1);
    assert.equal(v.contextGroups[0].group.id, "g2");
    assert.match(v.contextGroups[0].reasons[0].reason, /共享接口/);
    assert.deepEqual(
      projectGuide(f.explanation, f.version, { path: "src/" }).groups,
      v.groups,
    );
    assert.equal(
      projectGuide(f.explanation, f.version, { owner: "previous" }).groups[0]
        .id,
      "g2",
    );
    assert.equal(
      projectGuide(f.explanation, f.version, { path: "old" }).groups[0].id,
      "g2",
    );
    f.explanation.references.push({
      ...f.explanation.references[0],
      id: "return-context",
    });
    f.explanation.guide!.groups[1].context = [
      {
        group: 1,
        reason: "交叉调用",
        referenceIds: ["return-context"],
      },
    ];
    assert.equal(
      projectGuide(f.explanation, f.version, { owner: "runtime" }).contextGroups
        .length,
      1,
    );
    assert.ok(
      projectGuide(f.explanation, f.version, {
        owner: "runtime",
      }).references.some((r) => r.id === "return-context"),
    );
    assert.throws(() =>
      projectGuide(f.explanation, f.version, { owner: "missing" }),
    );
    assert.throws(() =>
      projectGuide(f.explanation, f.version, { owner: "runtime", path: "src" }),
    );
    for (const path of [
      "../secrets",
      ".git/config",
      "/etc/passwd",
      "src/../shared",
    ])
      assert.throws(() => projectGuide(f.explanation, f.version, { path }));
  } finally {
    f.cleanup();
  }
});

test("shared scopes and pinned links use frozen explanation ownership, never live provider reads; refresh is owner-only", async () => {
  const f = await scopeFixture(),
    viewer = await createServer(f.service, false),
    owner = await createServer(f.service, true);
  const headers = { authorization: `Bearer ${secret(f.root, "owner-token")}` };
  let calls = 0;
  const prior = f.service.rpc.bind(f.service);
  f.service.rpc = async <T>(method: string, p: any): Promise<T> => {
    if (method !== "ownership") return prior(method, p);
    calls++;
    return {
      ...f.ownership,
      files: f.ownership.files.map((file) => ({
        ...file,
        owners: ["new-owner"],
      })),
    } as T;
  };
  try {
    const base = `/api/v1/reviews/${f.review.id}`;
    const g = (await viewer.inject(base + "/guide?owner=runtime")).json().data;
    assert.equal(g.groups.length, 1);
    assert.equal(g.contextGroups.length, 1);
    assert.equal(calls, 0);
    const link = (await viewer.inject(base + "/share?owner=runtime")).json()
      .data.url;
    assert.ok(link.includes(`/v/${f.explanation.id}?owner=runtime`));
    assert.equal(
      (
        await viewer.inject({
          method: "POST",
          url: base + "/owners/refresh",
          payload: {},
        })
      ).statusCode,
      404,
    );
    const refresh = await owner.inject({
      method: "POST",
      url: base + "/owners/refresh",
      headers,
      payload: {},
    });
    assert.equal(refresh.statusCode, 200);
    assert.equal(calls, 1);
    assert.equal(
      (await viewer.inject(base + "/guide?owner=runtime")).json().data.groups
        .length,
      1,
    );
    assert.equal(
      (await viewer.inject(base + "/guide?owner=new-owner")).statusCode,
      404,
    );
    assert.ok(
      !(await viewer.inject(base + "/owners")).body.includes("new-owner"),
    );
    delete f.explanation.ownership;
    f.service.store.put("explanation", f.explanation);
    assert.equal((await viewer.inject(base + "/owners")).statusCode, 404);
    assert.equal(
      (await viewer.inject(base + "/guide?owner=runtime")).statusCode,
      404,
    );
    assert.equal(
      (await viewer.inject(base + "/guide?path=src")).statusCode,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    await owner.close();
    await viewer.close();
    f.cleanup();
  }
});
