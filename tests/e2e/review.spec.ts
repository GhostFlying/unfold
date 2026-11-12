import { test, expect, type Page } from "@playwright/test";
async function openOwner(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("所有者密钥")
    .fill("synthetic-test-owner-key-not-a-real-credential");
  await page.getByRole("button", { name: "打开工作区" }).click();
  await page.getByText("Make cancellation explicit", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make cancellation explicit" }),
  ).toBeVisible();
}
test("new run feedback streams live, recovers after reload and reconnect, and retains token usage after completion", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openOwner(page);
  const control = (action: string) =>
    request.post("http://127.0.0.1:19371/__fixture/telemetry", {
      headers: {
        authorization: "Bearer synthetic-test-owner-key-not-a-real-credential",
      },
      data: { action },
    });
  try {
    await control("start");
    await page.reload();
    const panel = page.getByRole("region", { name: "本次分析" });
    await expect(panel).toContainText("已核对取消操作，现在检查资源释放路径。");
    await expect(panel).toContainText("12,600");
    await expect(page.getByLabel("MR Agent", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "分析中…" })).toBeDisabled();
    await expect(panel).toContainText("进度已连接");
    await control("disconnect");
    await expect(panel).toContainText("正在恢复事件");
    await control("progress");
    await expect(panel).toContainText("19,600", { timeout: 15000 });
    await expect(panel).toContainText("8,234 字符");
    await expect(panel.getByLabel("已保存的讲解片段")).toContainText(
      "3 个生成片段",
    );
    await page.reload();
    await expect(panel).toContainText("19,600");
    await panel.getByText("任务详情与进度记录").click();
    await expect(panel.locator(".run-timeline")).toContainText(
      "已核对取消操作",
    );
    await expect(panel.locator(".run-timeline li")).toHaveCount(2);
    await page.screenshot({ path: "/tmp/unfold-run-progress-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await page.screenshot({ path: "/tmp/unfold-run-progress-mobile.png" });
    await control("finish");
    await expect(panel).toContainText("本次分析 · 已完成");
    await expect(panel).toContainText("19,600");
    await page.reload();
    await expect(panel).toContainText("19,600");
    await expect(panel.getByRole("button", { name: "停止" })).toHaveCount(0);
    await expect(panel).toContainText("其中缓存 14,000");
    await expect(panel.getByLabel("已保存的讲解片段")).toContainText(
      "3 个生成片段",
    );
    expect(errors).toEqual([]);
  } finally {
    await control("cleanup");
  }
});
test("owner reads interactive explanation, selects source, edits a draft and previews without publishing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openOwner(page);
  const frame = page.frameLocator('iframe[title="交互式改动讲解"]');
  await expect(
    frame.getByRole("heading", { name: "A clearer lifecycle for queued work" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Before", exact: true }).click();
  await expect(frame.locator("#trace")).toHaveText(
    "Queue → acquire worker → check cancellation",
  );
  await frame.getByRole("button", { name: "After", exact: true }).click();
  await expect(frame.locator("#trace")).toHaveText(
    "Queue → check cancellation → return",
  );
  await frame.getByText("src/queue.ts:2 ↗", { exact: true }).click();
  await expect(page.locator(".source-body")).toContainText(
    "if (item.cancelled) return;",
  );
  await page.getByRole("button", { name: "创建草稿 ↗" }).click();
  await page
    .getByLabel("评论草稿", { exact: true })
    .fill("Should cancellation release any queued resource?");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.locator(".draft-entry")).toContainText("src/queue.ts:2");
  await page.getByRole("button", { name: "预览发布 →", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Reviewed revision:");
  await expect(page.getByRole("dialog")).toContainText(
    "Should cancellation release any queued resource?",
  );
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("viewer can interact and read shared evidence but has no private data or write APIs", async ({
  page,
}) => {
  await openOwner(page);
  const reviewPath = new URL(page.url()).pathname;
  await page.context().clearCookies();
  await page.goto(`http://127.0.0.1:19370${reviewPath}`);
  await expect(
    page.getByRole("heading", { name: "Make cancellation explicit" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "问 Agent ↗" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /生成讲解|重新讲解/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel("MR Agent", { exact: true })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE-QUESTION-SENTINEL",
  );
  const data = await page.request.get(
    `http://127.0.0.1:19370/api/v1${reviewPath.replace("/r/", "/reviews/")}`,
  );
  expect(await data.text()).not.toContain("private-thread-id");
  expect(
    (
      await page.request.get("http://127.0.0.1:19370/api/v1/approvals")
    ).status(),
  ).toBe(404);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Before", exact: true }).click();
  await expect(frame.locator("#trace")).toContainText("acquire worker");
  await frame.getByText("src/queue.ts:2 ↗", { exact: true }).click();
  await expect(page.locator(".source-body")).toContainText(
    "if (item.cancelled) return;",
  );
});
test("untrusted JavaScript stays opaque and external fetch/navigation cannot exfiltrate", async ({
  page,
  context,
}) => {
  let externalRequests = 0;
  await context.route("https://exfil.example.test/**", async (route) => {
    externalRequests++;
    await route.abort();
  });
  await openOwner(page);
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Check isolation" }).click();
  await expect(frame.locator("#isolation")).toHaveText("opaque origin");
  expect(
    await page.locator("body").getAttribute("data-compromised"),
  ).toBeNull();
  const blocked = page.waitForEvent("console", {
    predicate: (message) => message.text().includes("frame-src"),
  });
  await frame
    .getByRole("button", { name: "Attempt external navigation" })
    .click();
  await blocked;
  expect(externalRequests).toBe(0);
  expect(page.url()).toContain("/r/");
  await expect(
    page.getByRole("heading", { name: "Make cancellation explicit" }),
  ).toBeVisible();
});
test("mobile layout keeps navigation, diff and owner inspector usable without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openOwner(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.getByRole("button", { name: "Diff", exact: true }).click();
  await page.getByRole("button", { name: /src\/queue.ts/ }).click();
  await expect(page.locator(".diff-line.add")).toContainText(
    "if (item.cancelled) return;",
  );
  await page.getByRole("button", { name: "问 Agent ↗", exact: true }).click();
  await expect(page.getByLabel("追问内容")).toBeVisible();
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await expect(page.getByLabel("追问内容")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test("inline MR settings automatically persist and restore inheritance through the CLI API", async ({
  page,
}) => {
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  const controls = page.getByRole("region", { name: "当前 MR 的 Agent 设置" });
  await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
  await controls.getByLabel("MR 模型").selectOption("test-model");
  await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
  await controls.getByLabel("MR thinking effort").selectOption("high");
  await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
  expect(
    (await (await page.request.get(`/api/v1/reviews/${reviewId}/agent`)).json())
      .data.overrides.traex,
  ).toEqual({ model: "test-model", effort: "high" });
  await page.reload();
  await expect(controls.getByLabel("MR 模型")).toHaveValue("test-model");
  await expect(controls.getByLabel("MR thinking effort")).toHaveValue("high");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await controls.getByLabel("MR thinking effort").selectOption("");
  await expect(controls.getByLabel("MR 模型")).toBeEnabled();
  await controls.getByLabel("MR 模型").selectOption("");
  await expect(controls.getByLabel("MR 模型")).toBeEnabled();
  expect(
    (await (await page.request.get(`/api/v1/reviews/${reviewId}/agent`)).json())
      .data.overrides.traex,
  ).toEqual({});
});

test("copied MR subpage links open the same canonical review in the UI", async ({
  page,
}) => {
  await openOwner(page);
  const expectedPath = new URL(page.url()).pathname;
  await page.getByRole("button", { name: "改动记录", exact: true }).click();
  await page
    .getByLabel("MR 或 PR 链接")
    .fill(
      "https://code.example.test/sample/queue/merge_requests/42/checks/jobs/123?to_version=2#checks",
    );
  await page.getByRole("button", { name: "打开 →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Make cancellation explicit" }),
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(expectedPath);
  await expect(page.locator(".review-breadcrumb a")).toHaveAttribute(
    "href",
    "https://code.example.test/sample/queue/merge_requests/42",
  );
});

test("visible MR dropdowns feed direct regeneration, retain failures, and leave global defaults unchanged", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  const settingsUrl = `/api/v1/reviews/${reviewId}/agent`;
  const global = (await (await page.request.get("/api/v1/config")).json()).data;
  const controls = page.getByRole("region", { name: "当前 MR 的 Agent 设置" });
  const submitted: any[] = [];
  const effective: any[] = [];
  await page.route(`**/api/v1/reviews/${reviewId}/analyze`, async (route) => {
    submitted.push(route.request().postDataJSON());
    effective.push((await (await page.request.get(settingsUrl)).json()).data);
    if (submitted.length === 1)
      await route.fulfill({
        status: 422,
        json: {
          ok: false,
          error: {
            code: "agent_error",
            message: "Synthetic backend temporarily unavailable",
          },
        },
      });
    else
      await route.fulfill({
        json: {
          ok: true,
          data: {
            id: "synthetic-generation-profile",
            reviewId,
            kind: "analysis",
            state: "succeeded",
            backend: "codex",
            model: "fast-model",
            effort: "high",
          },
        },
      });
  });
  try {
    await expect(controls.getByLabel("MR Agent")).toBeEnabled();
    await controls.getByLabel("MR Agent").selectOption("codex");
    await expect(controls.getByLabel("MR 模型")).toBeEnabled();
    await controls.getByLabel("MR 模型").selectOption("fast-model");
    await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
    await expect(controls.getByLabel("MR thinking effort")).toContainText(
      "默认 · low",
    );
    await expect(
      controls
        .getByLabel("MR thinking effort")
        .locator('option[value="medium"]'),
    ).toHaveCount(0);
    await controls.getByLabel("MR thinking effort").selectOption("high");
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeEnabled();
    expect(submitted).toHaveLength(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/unfold-inline-agent-desktop.png" });
    await controls.getByRole("button", { name: "重新讲解" }).click();
    await expect(controls.getByRole("alert")).toContainText(
      "Synthetic backend temporarily unavailable",
    );
    await expect(controls.getByLabel("MR 模型")).toHaveValue("fast-model");
    await expect(controls.getByLabel("MR thinking effort")).toHaveValue("high");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeInViewport();
    await controls.getByRole("button", { name: "重新讲解" }).click();
    await expect(controls.getByRole("alert")).toHaveCount(0);
    await expect(controls.getByLabel("MR 模型")).toHaveValue("fast-model");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/unfold-inline-agent-mobile.png" });
    expect(submitted).toEqual([{}, {}]);
    for (const settings of effective) {
      expect(settings.backend).toBe("codex");
      expect(settings.profiles.codex).toEqual({
        model: "fast-model",
        effort: "high",
      });
    }
    await page.reload();
    await expect(controls.getByLabel("MR Agent")).toHaveValue("codex");
    await expect(controls.getByLabel("MR 模型")).toHaveValue("fast-model");
    await expect(controls.getByLabel("MR thinking effort")).toHaveValue("high");
    expect(
      (await (await page.request.get("/api/v1/config")).json()).data,
    ).toEqual(global);
    expect(errors).toEqual([]);
  } finally {
    await page.request.patch(`/api/v1/reviews/${reviewId}`, {
      data: {
        backend: null,
        agentOverrides: { codex: { model: null, effort: null } },
      },
    });
  }
});

test("inline model catalog failures recover without a generation dialog", async ({
  page,
}) => {
  let modelReads = 0;
  await page.route("**/api/v1/agents/traex/models", async (route) => {
    modelReads++;
    if (modelReads === 1)
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: {
            code: "unavailable",
            message: "Synthetic catalog unavailable",
          },
        },
      });
    else await route.fallback();
  });
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  const controls = page.getByRole("region", { name: "当前 MR 的 Agent 设置" });
  await expect(controls.getByRole("alert")).toContainText(
    "Synthetic catalog unavailable",
  );
  await expect(
    controls.getByRole("button", { name: "重新讲解" }),
  ).toBeDisabled();
  await controls.getByRole("button", { name: "重新读取模型" }).click();
  await expect(controls.getByLabel("MR 模型")).toBeEnabled();
  let payload: any;
  await page.route(`**/api/v1/reviews/${reviewId}/analyze`, async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: "synthetic-inherited-effort",
          kind: "analysis",
          state: "succeeded",
        },
      },
    });
  });
  await controls.getByRole("button", { name: "重新讲解" }).click();
  await expect(
    controls.getByRole("button", { name: "重新讲解" }),
  ).toBeEnabled();
  expect(payload).toEqual({});
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("failed automatic MR saves keep controls editable and save corrections", async ({
  page,
}) => {
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  const controls = page.getByRole("region", { name: "当前 MR 的 Agent 设置" });
  let saves = 0;
  let releaseSave!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(`**/api/v1/reviews/${reviewId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    saves++;
    if (saves === 1) {
      await held;
      await route.fulfill({
        status: 503,
        json: {
          ok: false,
          error: { code: "unavailable", message: "Synthetic save unavailable" },
        },
      });
    } else await route.fallback();
  });
  try {
    await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
    await controls.getByLabel("MR thinking effort").selectOption("high");
    await expect(controls.getByRole("status")).toContainText("正在保存");
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeDisabled();
    releaseSave();
    await expect(controls.getByRole("alert")).toContainText(
      "Synthetic save unavailable",
    );
    await expect(controls.getByLabel("MR thinking effort")).toHaveValue("high");
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeDisabled();
    const original = (
      await (await page.request.get(`/api/v1/reviews/${reviewId}/agent`)).json()
    ).data;
    expect(original.overrides.traex?.effort).toBeUndefined();
    await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
    await expect(controls.getByLabel("MR 模型")).toBeEnabled();
    await controls.getByLabel("MR thinking effort").selectOption("medium");
    await expect(controls.getByRole("alert")).toHaveCount(0);
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeEnabled();
    const saved = (
      await (await page.request.get(`/api/v1/reviews/${reviewId}/agent`)).json()
    ).data;
    expect(saved.overrides.traex.effort).toBe("medium");
  } finally {
    releaseSave();
    await page.request.patch(`/api/v1/reviews/${reviewId}`, {
      data: { agentOverrides: { traex: { effort: null } } },
    });
  }
});

test("model changes replace incompatible inherited effort with a persisted model default, including no-effort models", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  const config = (await (await page.request.get("/api/v1/config")).json()).data;
  const controls = page.getByRole("region", { name: "当前 MR 的 Agent 设置" });
  try {
    for (const [model, inherited, expectedDefault] of [
      ["plain-model", "high", "默认"],
      ["fast-model", "medium", "默认 · low"],
    ]) {
      const base = await page.request.patch(`/api/v1/reviews/${reviewId}`, {
        data: {
          backend: "traex",
          agentOverrides: {
            traex: {
              model: "test-model",
              effort: null,
              modelDefaultEffort: false,
            },
          },
        },
      });
      expect(base.ok()).toBe(true);
      const cfg = await page.request.patch("/api/v1/config", {
        data: {
          agents: { traex: { ...config.agents.traex, effort: inherited } },
        },
      });
      expect(cfg.ok()).toBe(true);
      await page.reload();
      await expect(controls.getByLabel("MR 模型")).toBeEnabled();
      await expect(controls.getByLabel("MR thinking effort")).toHaveValue("");
      await controls.getByLabel("MR 模型").selectOption(model);
      await expect(
        controls.getByRole("button", { name: "重新讲解" }),
      ).toBeEnabled();
      await expect(controls.getByLabel("MR thinking effort")).toBeEnabled();
      await expect(controls.getByLabel("MR thinking effort")).toHaveValue(
        "model-default",
      );
      await expect(
        controls.getByLabel("MR thinking effort").locator("option:checked"),
      ).toHaveText(expectedDefault);
      await expect(controls.getByRole("alert")).toHaveCount(0);
      await expect(controls.getByRole("status")).toContainText("已改用此模型");
      const saved = (
        await (
          await page.request.get(`/api/v1/reviews/${reviewId}/agent`)
        ).json()
      ).data;
      expect(saved.overrides.traex).toEqual({
        model,
        modelDefaultEffort: true,
      });
      expect(saved.profiles.traex.effort).toBeUndefined();
      await page.reload();
      await expect(
        controls.getByRole("button", { name: "重新讲解" }),
      ).toBeEnabled();
      await expect(controls.getByLabel("MR thinking effort")).toHaveValue(
        "model-default",
      );
    }
    await page.screenshot({ path: "/tmp/unfold-compact-agent-desktop.png" });
    await controls.screenshot({
      path: "/tmp/unfold-compact-agent-toolbar.png",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await expect(
      controls.getByRole("button", { name: "重新讲解" }),
    ).toBeInViewport();
    await page.screenshot({ path: "/tmp/unfold-compact-agent-mobile.png" });
    expect(errors).toEqual([]);
  } finally {
    await page.request.patch("/api/v1/config", {
      data: { agents: { traex: config.agents.traex } },
    });
    await page.request.patch(`/api/v1/reviews/${reviewId}`, {
      data: {
        backend: null,
        agentOverrides: { traex: { model: null, effort: null } },
      },
    });
  }
});

test("saving unchanged settings confirms application without a manual connector restart", async ({
  page,
}) => {
  await openOwner(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("工作区设置");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "配置已生效",
  );
  await expect(page.getByRole("dialog")).not.toContainText("请重启");
  expect(errors).toEqual([]);
});

test("saved pending settings become applied automatically and readiness failures stay visible", async ({
  page,
}) => {
  await openOwner(page);
  const cfg = (await (await page.request.get("/api/v1/config")).json()).data;
  let status = { state: "applied" };
  await page.route("**/api/v1/config/status", (route) =>
    route.fulfill({ json: { ok: true, data: status } }),
  );
  await page.route("**/api/v1/config", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          json: {
            ok: true,
            data: { saved: true, config: cfg, application: status },
          },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("工作区设置");
  status = { state: "pending" };
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "当前任务结束后自动生效",
  );
  status = { state: "applied" };
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "配置已生效",
  );
  await page.unroute("**/api/v1/config");
  await page.route("**/api/v1/config", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          json: {
            ok: true,
            data: {
              saved: true,
              config: cfg,
              application: {
                state: "failed",
                error: "Synthetic readiness failure",
              },
            },
          },
        })
      : route.fallback(),
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "已保存，但应用失败",
  );
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Synthetic readiness failure",
  );
  await expect(page.getByRole("button", { name: "重试应用" })).toBeVisible();
});

test("logical groups open individual change explanations with source and scoped diff on desktop and mobile", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openOwner(page);
  await page.getByRole("button", { name: "改动导览", exact: true }).click();
  const guide = page.getByRole("region", { name: "逻辑改动导览" });
  await expect(guide).toContainText("2 组 · 2 项");
  await expect(
    guide.getByRole("heading", { name: "取消语义", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/unfold-change-guide-overview.png" });
  const nav = guide.getByRole("navigation", { name: "修改点导航" });
  await nav.getByRole("button", { name: "把取消检查前移" }).click();
  const point = guide.getByRole("article", { name: "修改点说明" });
  await expect(
    point.getByRole("heading", { name: "把取消检查前移" }),
  ).toBeVisible();
  await expect(point).toContainText("先获取 worker，再检查取消状态。");
  await expect(point).toContainText("先检查取消状态，再获取 worker。");
  await expect(point).toContainText("为什么这样改");
  await expect(point).toContainText("影响与待验证");
  await point.getByRole("button", { name: /src\/queue.ts:2/ }).click();
  await expect(page.locator(".source-body")).toContainText(
    "if (item.cancelled) return;",
  );
  await page.getByRole("button", { name: "关闭侧栏" }).click();
  await point.getByRole("button", { name: /src\/queue.ts.*\+1/ }).click();
  await expect(point.locator(".diff-line.add")).toContainText(
    "if (item.cancelled) return;",
  );
  await page.screenshot({ path: "/tmp/unfold-change-guide-point.png" });
  await point.getByRole("button", { name: "下一项 →" }).click();
  await expect(
    point.getByRole("heading", { name: "缩小资源获取范围" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: "/tmp/unfold-change-guide-mobile.png" });
  await point.getByRole("button", { name: "返回总览" }).click();
  await expect(
    guide.getByRole("heading", { name: "从修改目的开始阅读。" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("length failures distinguish an unpublished run from a retained previous explanation", async ({
  page,
}) => {
  await openOwner(page);
  const reviewId = new URL(page.url()).pathname.split("/")[2];
  let keepPrevious = false;
  await page.route(`**/api/v1/reviews/${reviewId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (!keepPrevious) delete body.data.explanation;
    await route.fulfill({ json: body });
  });
  await page.route(`**/api/v1/reviews/${reviewId}/runs`, (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: [
          {
            id: "failed-segmented-run",
            reviewId,
            kind: "analysis",
            state: "failed",
            backend: "traex",
            model: "test-model",
            error: "model output limit exceeded: length",
            errorCode: "agent_output_limit",
            createdAt: new Date().toISOString(),
            progress: {
              stage: "generating",
              message: "Saved",
              savedParts: 2,
              savedChars: 4000,
              at: new Date().toISOString(),
            },
          },
        ],
      },
    }),
  );
  await page.reload();
  const alert = page.locator(".inline-alert.error");
  await expect(alert).toContainText("模型单次输出达到长度上限");
  await expect(alert).toContainText("本次未生成可发布的讲解");
  await expect(alert).not.toContainText("已有讲解仍然保留");
  await expect(alert).toContainText("已保存的片段仍可通过 CLI 读取");
  await expect(page.getByLabel("已保存的讲解片段")).toContainText(
    "2 个生成片段",
  );
  keepPrevious = true;
  await page.reload();
  await expect(alert).toContainText("已有讲解仍然保留");
});
