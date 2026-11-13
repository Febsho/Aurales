import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  use: { baseURL: 'http://127.0.0.1:5175', serviceWorkers: 'block' },
  projects: [{ name: 'chromium-local', use: { ...devices['Desktop Chrome'] } }],
})
