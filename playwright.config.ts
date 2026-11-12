import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:19371",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm exec tsx tests/fixture-server.ts",
    url: "http://127.0.0.1:19371/healthz",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
