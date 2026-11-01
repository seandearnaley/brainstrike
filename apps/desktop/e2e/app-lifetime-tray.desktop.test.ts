import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readCommittedRunStatus } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { closeLastWindowLikeTheUser, readLastWindowClose } from './utils/durable-ui-state';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';
import { startThread } from './utils/new-thread';

/**
 * ADR-0033: the host outlives the window, not the app. Where a tray can show (the E2E seam stands
 * in for a Linux StatusNotifier host; Windows always has one, macOS keeps its Dock), closing the
 * last window leaves the app and its host running, a run under way finishes, and quitting is
 * still the one joined quit that exits 0.
 */
test.use({ electronEnv: { BRAINSTRIKE_E2E_STATUS_NOTIFIER_HOST: 'registered' } });

const FINAL_TEXT = 'TRAY_RUN_COMPLETE';
const MODEL = 'openrouter::openai/gpt-5.4';

test('closing the last window mid-run leaves the app running in the tray, the run completes, and quit exits 0', async ({
  electron,
}) => {
  test.setTimeout(180_000);
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-tray-run-'));
  electron.removeAfterClose(workspace);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = await startModelProviderShim(({ toolNames }) => {
    // Title generation runs without tools; only the root turn carries them.
    if (toolNames.length === 0) {
      return { finalText: 'Tray run' };
    }
    entered.resolve();
    return { beforeFinalText: release.promise, finalText: FINAL_TEXT };
  });
  const previous = {
    key: process.env['BRAINSTRIKE_OPENROUTER_API_KEY'],
    root: process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'],
    url: process.env['OPENROUTER_BASE_URL'],
  };
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-tray-run-provider-key';
  try {
    const window = await electron.ensureWindow();
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, { compositeModelKey: MODEL, provider: 'openrouter' });
    await enableAssistantCatalogModel(window, MODEL);
    await ensureAssistantShellVisible(window);

    await startThread(window, 'Say the closing sentence.');
    await entered.promise;
    const strip = window.getByRole('tablist', { name: 'Open assistant threads' });
    const tabId = (await strip.getByRole('tab').first().getAttribute('id')) ?? '';
    const threadId = tabId.replace('assistant-thread-tab-', '');
    expect(threadId).not.toBe('');
    expect(await readLastWindowClose(window)).toBe('keeps-running');

    const { app } = await electron.ensureContext();
    const main = app.process();
    expect(await closeLastWindowLikeTheUser(electron, window)).toEqual({ quit: false });
    expect(main.exitCode).toBeNull();

    // No window is open: the host the app launched finishes the run and commits its end.
    release.resolve();
    await expect
      .poll(() => readCommittedRunStatus(electron.getUserDataDir(), threadId), { timeout: 60_000 })
      .toBe('completed');
    expect(main.exitCode).toBeNull();

    // Quit (tray, app menu or OS) is the app's one joined quit.
    await Promise.all([once(main, 'close'), electron.dispose()]);
    expect({ code: main.exitCode, signal: main.signalCode }).toEqual({ code: 0, signal: null });
  } finally {
    release.resolve();
    try {
      await electron.dispose();
    } finally {
      await provider.close();
      for (const [key, value] of [
        ['OPENROUTER_BASE_URL', previous.url],
        ['BRAINSTRIKE_OPENROUTER_API_KEY', previous.key],
        ['BRAINSTRIKE_E2E_REAL_ROOT_PATH', previous.root],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }
});

test('with Keep running in the tray turned off, closing the last window quits with exit 0', async ({
  electron,
  window,
}) => {
  await new HomePage(window).openSettings();
  const startup = await new SettingsPage(window).openCategory(/Startup/u, 'startup');
  // An unpackaged copy registers no login item; Settings says so instead of offering it.
  await expect(startup.getByRole('switch', { name: 'Open at login' })).toBeDisabled();
  await expect(startup.getByText('Open at login is available in an installed copy')).toBeVisible();
  const keepRunning = startup.getByRole('switch', { name: 'Keep running in the tray when closed' });
  // macOS keeps its Dock: there is no tray choice to turn off.
  if ((await keepRunning.count()) === 0) {
    expect(await readLastWindowClose(window)).toBe('keeps-running');
    return;
  }
  await expect(keepRunning).toBeChecked();
  await keepRunning.click();
  await expect(keepRunning).not.toBeChecked();
  await expect(keepRunning).toBeEnabled();
  expect(await readLastWindowClose(window)).toBe('quits');

  expect(await closeLastWindowLikeTheUser(electron, window)).toEqual({ exitCode: 0, quit: true });
});
