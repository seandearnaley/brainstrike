import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { startThread } from './utils/new-thread';

async function openHostThread(page: Page): Promise<void> {
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
}

function assistantRegion(page: Page) {
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  return {
    input: region.getByRole('textbox', { name: 'Message input' }),
    queue: region.getByRole('list', { name: 'Queued follow-up messages' }),
    region,
  };
}

/**
 * A host run scripted to hold its reply until `hold` resolves. The title
 * request carries no tools; the thread's opening turn replies at once.
 */
function holdFirstReply(modelProvider: ModelProviderShim): PromiseWithResolvers<void> {
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Send lifecycle' };
    }
    const sent = JSON.stringify(messages);
    if (sent.includes('Second message')) {
      return { finalText: 'SECOND_REPLY' };
    }
    return sent.includes('First message')
      ? { beforeFinalText: hold.promise, finalText: 'FIRST_REPLY' }
      : { finalText: 'OPENED_REPLY' };
  });
  return hold;
}

/** An open thread, idle after its opening turn: the sends race on an existing thread. */
async function openIdleThread(page: Page) {
  await openHostThread(page);
  // The new-thread screen's first send creates the thread.
  await startThread(page, 'Open the thread');
  const assistant = assistantRegion(page);
  await expect(assistant.region.getByText('OPENED_REPLY', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(assistant.region.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
  return assistant;
}

/** The run turns (the title request carries no tools) whose prompt holds `text`. */
function runTurnsWith(modelProvider: ModelProviderShim, text: string) {
  return modelProvider
    .requests()
    .filter(({ toolNames }) => toolNames.length > 0)
    .map(({ messages }) => JSON.stringify(messages))
    .filter((sent) => sent.includes(text));
}

/** The second message ran once, after the first run's reply, and the host refused nothing. */
async function expectSecondRanAfterFirst(page: Page, modelProvider: ModelProviderShim) {
  const { input, queue, region } = assistantRegion(page);
  await expect(region.getByText('SECOND_REPLY', { exact: true })).toBeVisible({ timeout: 30_000 });
  const second = runTurnsWith(modelProvider, 'Second message');
  expect(second).toHaveLength(1);
  expect(second[0]).toContain('FIRST_REPLY');
  await expect(queue).toHaveCount(0);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([]);
}

/**
 * BST-1981/BST-2439: while a run is running, a second send waits in the queue
 * and is sent once the first reply ends; the host never refuses it. Only the
 * external provider is simulated; admission, the committed log, the queue and
 * the composer are the real ones.
 */
test('a send while a run is running waits in the queue and is sent after the first reply', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(120_000);
  const page = await electron.ensureWindow();
  const hold = holdFirstReply(modelProvider);
  const { input, queue, region } = await openIdleThread(page);
  await input.fill('First message');
  await input.press('Enter');
  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible({
    timeout: 30_000,
  });
  await input.fill('Second message');
  await input.press('Enter');

  await expect(queue).toContainText('Second message');
  await expect(input).toHaveValue('');
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(runTurnsWith(modelProvider, 'Second message')).toEqual([]);
  hold.resolve();
  await expect(region.getByText('FIRST_REPLY', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expectSecondRanAfterFirst(page, modelProvider);
});

/**
 * BST-1981/BST-2439: two Enters milliseconds apart. The second lands while the
 * first send is being admitted (its draft is kept) or once its run shows (it
 * is queued); which one is a matter of timing. Either way it is never
 * refused, never lost, and never runs while the first run is running.
 */
test('a second send milliseconds after the first is never refused, lost or run during the first', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(120_000);
  const page = await electron.ensureWindow();
  const hold = holdFirstReply(modelProvider);
  const { input, queue, region } = await openIdleThread(page);
  await input.fill('First message');
  // Two Enters milliseconds apart, as a fast typist sends them.
  await input.press('Enter');
  await input.fill('Second message');
  await input.press('Enter');

  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible({
    timeout: 30_000,
  });
  // Exactly once, in the composer's draft or in the queue.
  await expect
    .poll(
      async () =>
        Number((await input.inputValue()) === 'Second message') +
        (await queue.getByText('Second message', { exact: true }).count())
    )
    .toBe(1);
  await expect(page.getByRole('alert', { name: 'Agent command error' })).toHaveCount(0);
  expect(runTurnsWith(modelProvider, 'Second message')).toEqual([]);
  hold.resolve();
  await expect(region.getByText('FIRST_REPLY', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
  // A kept draft sends now; a queued message has already been sent, and
  // Enter on the empty composer sends nothing.
  await input.press('Enter');
  await expectSecondRanAfterFirst(page, modelProvider);
});

test('a reply the app quit mid-stream keeps its text and one interrupted marker after relaunch (BST-1982)', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(180_000);
  let page = await electron.ensureWindow();
  await openHostThread(page);
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ toolNames }) =>
    toolNames.length === 0
      ? { finalText: 'Interrupted lifecycle' }
      : {
          beforeFinalText: hold.promise,
          finalText: 'NEVER_COMMITTED',
          streamedBeforeHold: 'STREAMED_BEFORE_QUIT',
        }
  );
  const { input, region } = assistantRegion(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Run until the app quits.');
  await input.press('Enter');
  // The reply is streaming: its text shows live before the app quits.
  await expect(region.getByText('STREAMED_BEFORE_QUIT')).toBeVisible({ timeout: 30_000 });

  // Quit mid-stream: the host closes while the step is open.
  await electron.closeForStateSeeding();
  hold.resolve();
  page = await electron.ensureWindow();
  await openHostThread(page);
  const relaunched = assistantRegion(page).region;
  await expect(relaunched.getByText('Run until the app quits.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(relaunched.getByText('STREAMED_BEFORE_QUIT')).toBeVisible();
  await expect(relaunched.getByText('Reply interrupted', { exact: true })).toHaveCount(1);
  await expect(relaunched.getByText('NEVER_COMMITTED', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('quit-mid-stream-relaunched.png') });
});

test('a text-only Stop keeps its text and shows one Stopped marker, after a reload too (BST-1982)', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(120_000);
  const page = await electron.ensureWindow();
  await openHostThread(page);
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ toolNames }) =>
    toolNames.length === 0
      ? { finalText: 'Stopped lifecycle' }
      : {
          beforeFinalText: hold.promise,
          finalText: 'NEVER_COMMITTED',
          streamedBeforeHold: 'STREAMED_BEFORE_STOP',
        }
  );
  const { input, region } = assistantRegion(page);
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill('Write until I stop you.');
  await input.press('Enter');
  await expect(region.getByText('STREAMED_BEFORE_STOP')).toBeVisible({ timeout: 30_000 });
  await region.getByRole('button', { exact: true, name: 'Stop' }).click();
  await expect(region.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0, {
    timeout: 30_000,
  });
  hold.resolve();
  await expect(region.getByText('STREAMED_BEFORE_STOP')).toBeVisible();
  await expect(region.getByText('Stopped', { exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('text-only-stop.png') });

  // A reload folds the same committed log.
  await reloadRenderer(page, 'host-thread-send-lifecycle: reload');
  await openHostThread(page);
  const reloaded = assistantRegion(page).region;
  await expect(reloaded.getByText('Write until I stop you.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(reloaded.getByText('STREAMED_BEFORE_STOP')).toBeVisible();
  await expect(reloaded.getByText('Stopped', { exact: true })).toHaveCount(1);
  await expect(reloaded.getByText('NEVER_COMMITTED', { exact: true })).toHaveCount(0);
});
