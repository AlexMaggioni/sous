import { defineConfig } from "@playwright/test";

// The end-to-end checks: a real `sous serve` on a throwaway world (e2e/serve.mjs), driven in the
// installed Google Chrome, so no browser download. Build the cli and the page first.

const PORT = 4417;
export const TOKEN = "e2e";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node e2e/serve.mjs --port ${PORT} --token ${TOKEN} --runs`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
  },
});
