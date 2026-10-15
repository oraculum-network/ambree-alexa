import { defineConfig, devices } from "@playwright/test";

// Port base 3871: the app on 3871, the mock MET feed on 3872, mock GDACS on 3873.
const PORT = 3871;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node e2e/serve.ts",
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
