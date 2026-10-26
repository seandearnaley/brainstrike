// A real MCP task survives a genuine restart of the packaged app (BST-1565,
// rebuilt on the current owner by BST-2130). The agent host's task host owns
// the task in its state store; the first launch starts it against the
// tasks-reference server and closes with its input still pending. The second
// launch must show it as restart-required, recover it through the card, and
// cancel it exactly once, after which nothing keeps polling the server.
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, type TestInfo, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { _electron as electron } from 'playwright';
import { readCommittedMcpTasks } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { closeElectronApp } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startPendingInputFixture } from './utils/mcp-pending-input-fixture';
import {
  beginPendingInputTask,
  configurePendingInputServer,
  PENDING_INPUT_TOOL_NAME,
} from './utils/mcp-task-flow';
import { startModelProviderShim } from './utils/model-provider-shim';

const PROVIDER_KEY = 'test-key-bst2130';
const FINAL_TEXT = 'The task observation has returned.';
const MODEL = 'openrouter::openai/gpt-5.4';

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

interface PackagedLaunch {
  readonly app: ElectronApplication;
  readonly page: Page;
}

async function launchPackagedApp(
  executablePath: string,
  userDataDir: string,
  environment: Readonly<Record<string, string>>
): Promise<PackagedLaunch> {
  const app = await electron.launch({
    args: [
      '--test-mode',
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    env: {
      ...electronEnvironment(),
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_USER_DATA_DIR: userDataDir,
      ELECTRON_IS_E2E_TEST: 'true',
      NODE_OPTIONS: '',
      ...environment,
    },
    executablePath,
    timeout: 120_000,
  });
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function closePackagedApp(app: ElectronApplication): Promise<void> {
  const window = app.windows().find((candidate) => !candidate.isClosed());
  if (!window) {
    await app.close();
    return;
  }
  await closeElectronApp({ app, window });
}

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: 'application/json',
  });
}

test(
  'a real MCP task is recovered fenced and quiescent across a genuine packaged restart',
  {
    tag: ['@destructive', '@packaged'],
  },
  async ({}, testInfo) => {
    test.setTimeout(300_000);
    const executablePath = packagedExecutablePath();
    await access(executablePath, constants.X_OK);
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'bst-2130-packaged-user-data-'));
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'bst-2130-workspace-'));
    const server = await startPendingInputFixture();
    const provider = await startModelProviderShim({
      deferredTool: true,
      finalText: FINAL_TEXT,
      toolCall: { arguments: {}, name: PENDING_INPUT_TOOL_NAME },
    });
    const environment = {
      BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
      BRAINSTRIKE_OPENROUTER_API_KEY: PROVIDER_KEY,
      OPENROUTER_BASE_URL: provider.baseUrl,
    };
    const readTasks = () => readCommittedMcpTasks(userDataDir);
    let first: PackagedLaunch | undefined;
    let second: PackagedLaunch | undefined;
    let fixturesClosed = false;
    try {
      first = await launchPackagedApp(executablePath, userDataDir, environment);
      await ensureMockWorkspaceOpen(first.page);
      await configurePendingInputServer(first.page, server.url);
      await configureAssistantProvider(first.page, {
        apiKey: PROVIDER_KEY,
        compositeModelKey: MODEL,
        provider: 'openrouter',
      });
      await enableAssistantCatalogModel(first.page, MODEL);
      await ensureAssistantShellVisible(first.page);
      await beginPendingInputTask(first.page, 'Start the task that must survive a restart.');
      const pending = await readTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.status).toBe('input_required');
      const taskId = pending[0]?.taskId;
      // The tool settles on the live task once its bounded wait (45 s) ends, so
      // the thread keeps the task's card; the run then completes. Closing before
      // that would leave the call's effect uncertain and the run interrupted.
      await expect(first.page.getByText(FINAL_TEXT, { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      expect((await readTasks())[0]).toMatchObject({ status: 'input_required', taskId });
      // The app closes with the task's input still pending on the server.
      await closePackagedApp(first.app);
      first = undefined;
      const beforeRestart = server.snapshot().requests.length;

      second = await launchPackagedApp(executablePath, userDataDir, environment);
      const { page } = second;
      await ensureAssistantShellVisible(page);
      // The host's state store carried the row across the restart.
      // The relaunched host publishes its record when it starts; until then there is none to read.
      await expect
        .poll(() => readTasks().catch(() => []), { timeout: 60_000 })
        .toEqual([expect.objectContaining({ status: 'input_required', taskId })]);
      // The thread kept the task's card. The same server definition reconnects,
      // so the host rebinds the task's live epoch and resumes it on its own: the
      // card is live, not restart-required, and the host polls the task again.
      const card = page.getByTestId('mcp-task-status-card').first();
      await expect(card.getByTestId('mcp-task-status-summary')).toContainText('Input required', {
        timeout: 60_000,
      });
      await expect(card.getByRole('button', { name: 'Recover task' })).toHaveCount(0);
      await expect
        .poll(() =>
          server
            .snapshot()
            .requests.slice(beforeRestart)
            .some((request) => request.taskId === taskId && request.method !== 'tasks/cancel')
        )
        .toBe(true);
      // The first launch's input request did not survive the restart; nothing answered it.
      await expect(page.getByText('This server input is no longer available.')).toBeVisible();
      expect(server.snapshot().requests.filter(({ method }) => method === 'tasks/update')).toEqual(
        []
      );
      expect(server.snapshot().requests.filter(({ method }) => method === 'tasks/cancel')).toEqual(
        []
      );
      await card.getByRole('button', { exact: true, name: 'Cancel task' }).click();
      await expect.poll(() => server.snapshot().cancellationAcknowledged).toBe(true);
      server.releaseTerminalObservation();
      await expect.poll(async () => (await readTasks())[0]?.status).toBe('cancelled');
      await expect(card.getByTestId('mcp-task-status-summary')).toContainText('Cancelled');
      await expect(card.getByRole('button', { name: /cancel task|recover task/i })).toHaveCount(0);
      expect(
        server
          .snapshot()
          .requests.filter(({ method, taskId: id }) => method === 'tasks/cancel' && id === taskId)
      ).toHaveLength(1);
      const terminal = await readTasks();
      await closePackagedApp(second.app);
      second = undefined;
      // Quiescent: after the terminal state and close, nothing polls the task.
      const settled = server.snapshot().requests.length;
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      expect(server.snapshot()).toMatchObject({ activeRequests: 0 });
      expect(server.snapshot().requests.length).toBe(settled);
      await attachEvidence(testInfo, 'packaged-restart-observation', {
        provider: provider.transcript(),
        server: server.snapshot(),
        tasks: terminal,
      });
      // The fixtures close cleanly: a relay error or an incomplete MCP lab
      // cleanup rejects here, and nothing is left listening or open.
      fixturesClosed = true;
      const closed = await Promise.allSettled([provider.close(), server.close()]);
      const failures = closed.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'BST-2130 provider or Tasks reference cleanup failed');
      }
      await expect
        .poll(() => server.snapshot())
        .toMatchObject({ activeRequests: 0, listening: false, openSockets: 0 });
    } finally {
      if (first) {
        await closePackagedApp(first.app);
      }
      if (second) {
        await closePackagedApp(second.app);
      }
      if (!fixturesClosed) {
        // A failure above is the result; closing here must not replace it.
        await Promise.allSettled([provider.close(), server.close()]);
      }
      await rm(userDataDir, { force: true, recursive: true });
      await rm(workspace, { force: true, recursive: true });
    }
  }
);
