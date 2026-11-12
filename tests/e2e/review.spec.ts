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
