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
    await expect(panel).toContainText("进度已连接");
    await control("disconnect");
    await expect(panel).toContainText("正在恢复事件");
    await control("progress");
    await expect(panel).toContainText("19,600", { timeout: 15000 });
    await expect(panel).toContainText("8,234 字符");
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
  await expect(page.getByRole("button", { name: "生成讲解" })).toHaveCount(0);
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

test("MR model and thinking effort overrides use the same persistent API as CLI", async ({
  page,
}) => {
  await openOwner(page);
  await page.getByRole("button", { name: "当前 MR 的 Agent 设置" }).click();
  await expect(page.getByRole("dialog")).toContainText("此 MR 的 Agent 设置");
  await page
    .getByLabel("traex 模型", { exact: true })
    .selectOption("test-model");
  await page
    .getByLabel("traex thinking effort", { exact: true })
    .selectOption("high");
  await page.getByRole("button", { name: "保存 MR 设置", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "当前 MR 的 Agent 设置" }).click();
  await expect(
    page.getByLabel("traex thinking effort", { exact: true }),
  ).toHaveValue("high");
  await page
    .getByLabel("traex thinking effort", { exact: true })
    .selectOption("");
  await page.getByRole("button", { name: "保存 MR 设置", exact: true }).click();
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
  await expect(page.getByRole("status")).toContainText("配置已生效");
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
  await expect(page.getByRole("status")).toContainText(
    "当前任务结束后自动生效",
  );
  status = { state: "applied" };
  await expect(page.getByRole("status")).toContainText("配置已生效");
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
  await expect(page.getByRole("status")).toContainText("已保存，但应用失败");
  await expect(page.getByRole("status")).toContainText(
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
