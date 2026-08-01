import { defineConfig, devices } from '@playwright/test';

const DEFAULT_E2E_PORT = 4175;

function readPort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_E2E_PORT;
  }
  const port = Number(value);
  if (!(Number.isInteger(port) && port > 0 && port <= 65_535)) {
    throw new Error('SITE_E2E_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

const port = readPort(process.env['SITE_E2E_PORT']);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  expect: { timeout: 8000 },
  forbidOnly: process.env['CI'] === 'true',
  fullyParallel: false,
  outputDir: 'test-results',
  projects: [
    {
      name: 'core-chromium',
      testIgnore: '**/webgpu-ready.test.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { height: 900, width: 1440 },
      },
    },
    {
      name: 'core-mobile-chromium',
      testIgnore: '**/webgpu-ready.test.ts',
      use: {
        ...devices['Pixel 7'],
      },
    },
    {
      name: 'core-firefox',
      testIgnore: '**/webgpu-ready.test.ts',
      use: { ...devices['Desktop Firefox'], viewport: { height: 900, width: 1440 } },
    },
    {
      name: 'core-webkit',
      testIgnore: '**/webgpu-ready.test.ts',
      use: { ...devices['Desktop Safari'], viewport: { height: 900, width: 1440 } },
    },
    {
      name: 'webgpu-chromium',
      testMatch: '**/webgpu-ready.test.ts',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: ['--enable-unsafe-webgpu'] },
        viewport: { height: 900, width: 1440 },
      },
    },
  ],
  reporter: process.env['CI'] === 'true' ? [['list'], ['html', { open: 'never' }]] : 'list',
  retries: process.env['CI'] === 'true' ? 1 : 0,
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    stderr: 'pipe',
    stdout: 'pipe',
    timeout: 30_000,
    url: baseURL,
  },
  workers: 2,
});
