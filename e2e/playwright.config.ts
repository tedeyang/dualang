import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  globalSetup: './global-setup.ts',
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
    // 扩展测试的 headless 由 fixtures.ts 里的 --headless=new arg 控制
  },
  webServer: {
    command: 'cd .. && uv run python3 -m http.server 9999',
    url: 'http://localhost:9999',
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
