import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { APP_RENDERER_DOCUMENT_URL } from '../src/desktop-renderer-origin';
import { closeElectronApp } from './utils/electron-helpers.mts';

type HarnessScenario =
  | 'live'
  | 'stale_epoch'
  | 'lost_principal'
  | 'capability_removed'
  | 'unsupported_version';

interface HarnessSnapshot {
  readonly databaseOpen: boolean;
  readonly interaction: {
    readonly activeCancellations: number;
    readonly activeInputs: number;
    readonly inputKeys: number;
    readonly subscriptionActive: boolean;
  };
  readonly lifecycle: {
    readonly activePolls: number;
    readonly activeTasks: number;
    readonly queuedPolls: number;
    readonly timers: number;
  };
  readonly listenerCount: number;
  readonly pendingCancellation: boolean;
  readonly recovery: 'live' | 'restart_required' | 'terminal';
  readonly status: 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed';
}

interface HarnessControl {
  close(): Promise<HarnessSnapshot>;
  releaseCancellation(): Promise<void>;
  setScenario(scenario: HarnessScenario): void;
  snapshot(): HarnessSnapshot;
}

declare global {
  interface Window {
    __brainstrikeMcpTaskHarness__?: HarnessControl;
  }
}

function packagedExecutablePath(): string {
  const releaseRoot = path.resolve(process.cwd(), 'release');
  if (process.platform === 'darwin') {
    const outputDirectory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    return path.join(
      releaseRoot,
      outputDirectory,
      'BrainStrike Desktop.app',
      'Contents',
      'MacOS',
      'BrainStrike Desktop'
    );
  }
  if (process.platform === 'win32') {
    const outputDirectory = process.arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked';
    return path.join(releaseRoot, outputDirectory, 'BrainStrike Desktop.exe');
  }
  if (process.platform === 'linux') {
    const outputDirectory = process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked';
    return path.join(releaseRoot, outputDirectory, 'brainstrike-desktop');
  }
  throw new Error(`Packaged MCP Tasks verifier does not support ${process.platform}`);
}

function electronEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || value === undefined) {
      continue;
    }
    environment[key] = value;
  }
  return environment;
}

async function launchPackagedApp(
  executablePath: string,
  userDataDir: string
): Promise<ElectronApplication> {
  return await electron.launch({
    args: [
      '--test-mode',
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    env: {
      ...electronEnvironment(),
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_DISABLE_EXTERNAL_LOCAL_RUNTIME_PROBES: '1',
      BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
      BRAINSTRIKE_OPENAI_API_KEY: 'test-api-key-for-e2e-tests',
      ELECTRON_IS_E2E_TEST: 'true',
      NODE_OPTIONS: '',
    },
    executablePath,
    timeout: 120_000,
  });
}

async function openHarness(app: ElectronApplication): Promise<Page> {
  await app.evaluate(async ({ app: electronApp, BrowserWindow }, documentUrl) => {
    const appPath = electronApp.getAppPath();
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: `${appPath}/dist/preload.js`,
        sandbox: false,
        webSecurity: true,
      },
    });
    await window.loadURL(`${documentUrl}?mode=mcp-task-harness`);
  }, APP_RENDERER_DOCUMENT_URL);
  await expect
    .poll(() => app.windows().some((candidate) => candidate.url().includes('mcp-task-harness')))
    .toBe(true);
  const page = app.windows().find((candidate) => candidate.url().includes('mcp-task-harness'));
  if (!page) {
    throw new Error('Packaged MCP Tasks harness window was not created.');
  }
  const rendererErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => rendererErrors.push(error.message));
  try {
    await page.waitForFunction(
      () => window.__brainstrikeMcpTaskHarness__ !== undefined,
      undefined,
      {
        timeout: 30_000,
      }
    );
  } catch (error) {
    throw new Error(
      `Packaged MCP Tasks harness did not become ready at ${page.url()}: ${rendererErrors.join(' | ')}`,
      { cause: error }
    );
  }
  await expect(page.getByTestId('mcp-task-status-card')).toBeVisible();
  return page;
}

async function closePackagedApp(app: ElectronApplication): Promise<void> {
  const window = app.windows().find((candidate) => !candidate.isClosed());
  if (!window) {
    await app.close();
    return;
  }
  await closeElectronApp({ app, window });
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  return await page.evaluate(() => {
    const harness = window.__brainstrikeMcpTaskHarness__;
    if (!harness) {
      throw new Error('MCP Tasks packaged harness is unavailable.');
    }
    return harness.snapshot();
  });
}

async function closeHarness(page: Page): Promise<HarnessSnapshot> {
  return await page.evaluate(async () => {
    const harness = window.__brainstrikeMcpTaskHarness__;
    if (!harness) {
      throw new Error('MCP Tasks packaged harness is unavailable.');
    }
    return await harness.close();
  });
}

async function setScenario(page: Page, scenario: HarnessScenario): Promise<void> {
  await page.evaluate((nextScenario) => {
    const harness = window.__brainstrikeMcpTaskHarness__;
    if (!harness) {
      throw new Error('MCP Tasks packaged harness is unavailable.');
    }
    harness.setScenario(nextScenario);
  }, scenario);
}

test('MCP task recovery is fenced and quiescent across a genuine packaged restart', {
  tag: ['@destructive', '@packaged'],
}, async () => {
  test.setTimeout(240_000);
  const executablePath = packagedExecutablePath();
  await access(executablePath, constants.X_OK);
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-1565-packaged-user-data-'));
  let firstApp: ElectronApplication | undefined;
  let secondApp: ElectronApplication | undefined;
  try {
    firstApp = await launchPackagedApp(executablePath, userDataDir);
    expect(await firstApp.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const firstPage = await openHarness(firstApp);
    await expect(firstPage.getByTestId('mcp-task-status-summary')).toContainText('Working');
    await expect(firstPage.getByRole('button', { name: 'Recover task' })).toHaveCount(0);
    expect(await snapshot(firstPage)).toMatchObject({
      databaseOpen: true,
      listenerCount: 1,
      recovery: 'live',
      status: 'working',
    });
    expect(await closeHarness(firstPage)).toMatchObject({
      databaseOpen: false,
      interaction: {
        activeCancellations: 0,
        activeInputs: 0,
        inputKeys: 0,
        subscriptionActive: false,
      },
      lifecycle: { activePolls: 0, activeTasks: 0, queuedPolls: 0, timers: 0 },
      listenerCount: 0,
      pendingCancellation: false,
    });
    await closePackagedApp(firstApp);
    firstApp = undefined;

    secondApp = await launchPackagedApp(executablePath, userDataDir);
    expect(await secondApp.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const secondPage = await openHarness(secondApp);
    await expect(secondPage.getByRole('button', { name: 'Recover task' })).toBeVisible();
    expect(await snapshot(secondPage)).toMatchObject({
      databaseOpen: true,
      recovery: 'restart_required',
      status: 'working',
    });

    await setScenario(secondPage, 'lost_principal');
    await secondPage.getByRole('button', { name: 'Recover task' }).click();
    await expect(secondPage.getByRole('alert')).toContainText(
      'authorization principal that owns this MCP task is no longer available'
    );
    await expect(secondPage.getByRole('alert')).toBeFocused();

    await setScenario(secondPage, 'live');
    await secondPage.getByRole('button', { name: 'Recover task' }).click();
    await expect(secondPage.getByText('Packaged task is working')).toBeVisible();
    await expect(secondPage.getByRole('button', { name: 'Recover task' })).toHaveCount(0);
    await expect(secondPage.getByTestId('mcp-task-status-summary')).toBeFocused();

    await setScenario(secondPage, 'stale_epoch');
    await secondPage.getByRole('button', { name: 'Cancel task' }).click();
    await expect(secondPage.getByRole('alert')).toContainText('replaced server connection');
    await expect(secondPage.getByTestId('mcp-task-status-summary')).toContainText('Working');

    await setScenario(secondPage, 'live');
    await secondPage.getByRole('button', { name: 'Cancel task' }).click();
    await expect(secondPage.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    await expect(secondPage.getByTestId('mcp-task-status-summary')).toContainText('Working');
    expect(await snapshot(secondPage)).toMatchObject({ pendingCancellation: true });
    await secondPage.evaluate(async () => {
      await window.__brainstrikeMcpTaskHarness__?.releaseCancellation();
    });
    await expect(secondPage.getByTestId('mcp-task-status-summary')).toContainText('Cancelled');
    await expect(secondPage.getByTestId('mcp-task-status-summary')).toBeFocused();
    await expect(secondPage.getByRole('button', { name: /cancel/i })).toHaveCount(0);

    expect(await closeHarness(secondPage)).toMatchObject({
      databaseOpen: false,
      interaction: {
        activeCancellations: 0,
        activeInputs: 0,
        inputKeys: 0,
        subscriptionActive: false,
      },
      lifecycle: { activePolls: 0, activeTasks: 0, queuedPolls: 0, timers: 0 },
      listenerCount: 0,
      pendingCancellation: false,
      recovery: 'terminal',
      status: 'cancelled',
    });
  } finally {
    if (firstApp) {
      await closePackagedApp(firstApp);
    }
    if (secondApp) {
      await closePackagedApp(secondApp);
    }
    await rm(userDataDir, { force: true, recursive: true });
  }
});
