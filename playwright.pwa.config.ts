import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/pwa',
  outputDir: './test-results/pwa',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5176',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run preview:web -- --host 127.0.0.1 --port 5176 --strictPort',
    url: 'http://127.0.0.1:5176',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
