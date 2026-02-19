import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Start the server before tests
  webServer: {
    command: "bun run index.ts",
    port: 3000,
    reuseExistingServer: true,
    timeout: 10000,
  },
});
