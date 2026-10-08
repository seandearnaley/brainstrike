import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-ux-parity';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FIRST_PROMPT = 'Start the first host run.';
const FIRST_REPLY = 'The first host run is done.';
const QUEUED = 'Queued while the first host run was active.';
const SECOND_REPLY = 'The queued host run is done.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

interface RecordedNotification {
  readonly body: string | undefined;
  readonly title: string;
}

/** Records OS notifications in the renderer; the platform permission reads as granted. */
async function recordNotifications(page: Page): Promise<void> {
  await page.evaluate(() => {
    const recorded: RecordedNotification[] = [];
    (window as unknown as { __notifications: RecordedNotification[] }).__notifications = recorded;
    class RecordingNotification {
      static readonly permission = 'granted';
      static requestPermission(): Promise<string> {
        return Promise.resolve('granted');
      }
      onclick: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        recorded.push({ body: options?.body, title });
      }
    }
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: RecordingNotification,
    });
  });
}

function readNotifications(page: Page): Promise<readonly RecordedNotification[]> {
  return page.evaluate(
    () => (window as unknown as { __notifications: RecordedNotification[] }).__notifications
  );
}

/** The window loses focus: the app-active signal the notification gate reads goes false. */
async function leaveWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    window.dispatchEvent(new Event('blur'));
  });
}

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await page.evaluate(async (model) => {
    const db = (
      window as unknown as {
        electronAPI: { db: { query: (sql: string, params: unknown[]) => Promise<unknown> } };
      }
    ).electronAPI.db;
    await db.query('UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
      model,
      'openrouter',
    ]);
  }, MODEL);
}

test('a host thread queues a follow-up, badges its runs, and notifies when they finish', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await recordNotifications(page);
  await new HomePage(page).openSettings();
  const notifications = await new SettingsPage(page).openCategory(
    /Notifications/i,
    'notifications'
  );
  const master = notifications.getByTestId('notifications-master-toggle');
  await master.click();
  await expect(master).toBeChecked();
  await page.keyboard.press('Escape');
  await enableModel(page);

  const release = Promise.withResolvers<void>();
  modelProvider.setScript((request) =>
    JSON.stringify(request.messages).includes(QUEUED)
      ? { finalText: SECOND_REPLY }
      : { beforeFinalText: release.promise, finalText: FIRST_REPLY }
  );
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  const strip = page.getByTestId('assistant-thread-tab-strip');
  await input.fill(FIRST_PROMPT);
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  // Running: the tab badge reads the host's committed run state.
  await expect(strip.getByRole('tab', { name: /, running$/ })).toBeVisible({ timeout: 60_000 });
  await input.fill(QUEUED);
  await region.getByRole('button', { name: 'Queue message to send after this run' }).click();
  await expect(region.getByRole('list', { name: 'Queued follow-up messages' })).toContainText(
    QUEUED
  );
  await expect(input).toHaveValue('');

  await leaveWindow(page);
  release.resolve();
  await expect(region.getByText(FIRST_REPLY)).toBeVisible({ timeout: 60_000 });
  await expect(region.getByText(SECOND_REPLY)).toBeVisible({ timeout: 90_000 });
  await expect(region.getByRole('list', { name: 'Queued follow-up messages' })).toHaveCount(0);
  // Finished while the window was away: unseen.
  await expect(strip.getByRole('tab', { name: /, finished$/ })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => readNotifications(page), { timeout: 30_000 })
    .toEqual([
      { body: 'Finished responding.', title: 'Assistant' },
      { body: 'Finished responding.', title: 'Assistant' },
    ]);

  // Core admitted the queued message as the thread's next run, once.
  const log = await readAgentHostLog(electron.getUserDataDir());
  expect(log.typeCounts['run.started']).toBe(2);
  expect(log.typeCounts['run.finished']).toBe(2);
  expect(
    modelProvider.requests().filter((request) => JSON.stringify(request.messages).includes(QUEUED))
  ).not.toHaveLength(0);
  expect(modelProvider.refusals()).toEqual([]);
});
