import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readAgentHostLog } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

const API_KEY = 'test-key-host-ux-parity';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const FIRST_PROMPT = 'Start the first host run.';
const FIRST_REPLY = 'The first host run is done.';
const QUEUED = 'Queued while the first host run was active.';
const SECOND_REPLY = 'The queued host run is done.';
const ANSWERED_REPLY = 'Local it is.';

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
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

/** Notifications on (recorded), and the shim's model enabled. */
async function prepare(page: Page): Promise<void> {
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
}

test('a host thread queues a follow-up, badges its runs, and notifies when they finish', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await prepare(page);

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

test('a host question badges its thread as needing input and notifies once', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  await prepare(page);
  modelProvider.setScript((request) => {
    const name = request.toolNames.find((tool) => tool.endsWith('askUser'));
    return name
      ? {
          finalText: ANSWERED_REPLY,
          toolCall: {
            arguments: {
              options: [{ label: 'Local' }, { label: 'Preview' }],
              question: 'Which environment?',
              selectionMode: 'multi_select',
            },
            name,
          },
        }
      : { finalText: `No askUser tool offered: ${request.toolNames.join(', ')}` };
  });
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const strip = page.getByTestId('assistant-thread-tab-strip');
  await leaveWindow(page);
  await region.getByRole('textbox', { name: 'Message input' }).fill('Ask me which environment.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();

  const form = region.getByRole('group', { name: 'Question for you' });
  await expect(form).toBeVisible({ timeout: 90_000 });
  await expect(strip.getByRole('tab', { name: /, needs your input$/ })).toBeVisible();
  // The Threads panel row shows the same pending state, from the host's committed runs.
  const needsYou = page.getByTestId('thread-row').getByTestId('thread-needs-you-glyph');
  await expect(needsYou).toHaveCount(1);
  await expect
    .poll(() => readNotifications(page), { timeout: 30_000 })
    .toEqual([{ body: 'Has a question for you.', title: 'Assistant' }]);

  await form.getByRole('checkbox', { name: 'Local' }).check();
  await form.getByRole('button', { name: 'Send answer' }).click();
  await expect(region.getByText(ANSWERED_REPLY)).toBeVisible({ timeout: 90_000 });
  await expect(strip.getByRole('tab', { name: /, finished$/ })).toBeVisible({ timeout: 30_000 });
  await expect(needsYou).toHaveCount(0);
  await expect
    .poll(() => readNotifications(page), { timeout: 30_000 })
    .toEqual([
      { body: 'Has a question for you.', title: 'Assistant' },
      { body: 'Finished responding.', title: 'Assistant' },
    ]);
  expect(modelProvider.refusals()).toEqual([]);
});
