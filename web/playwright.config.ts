import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  fullyParallel: false,
  retries: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium" }
  },
  webServer: {
    command: "npm run seed && npm run dev",
    cwd: "..",
    env: { ...process.env, SIMULATOR_ENABLED: "false" },
    url: "http://127.0.0.1:3000/kiosk",
    reuseExistingServer: true,
    timeout: 120_000
  }
});
