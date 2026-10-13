/**
 * Desktop E2E (BST-2004): the thread pane reconnects when the agent host is
 * replaced. Only the external provider is simulated; Main's host lease, Core's
 * recovery, the committed log and the pane are the real ones.
 *
 * 1. The host is killed mid-reply. The pane reconnects with no click to the
 *    host Main relaunches. Core commits the reply as interrupted, the provider
 *    is never asked for it again, and the thread takes a new send.
 * 2. That host is lost too, before the user reconnects, with a send it never
 *    read (the host is stopped, then killed). The pane waits for Reconnect,
 *    and the send comes back to the composer with "Not sent: the agent host
 *    restarted." Nothing is resent.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostProcess, readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

const FIRST_PROMPT = 'Reply until the host is lost';
const STREAMING = 'RECONNECT_STREAMING_2004';
const NEVER = 'RECONNECT_NEVER_COMMITTED_2004';
const SECOND_PROMPT = 'Reply on the new host';
const SECOND_REPLY = 'RECONNECT_SECOND_REPLY_2004';
const UNREAD_PROMPT = 'The stopped host never reads this';
const DISCONNECTED = 'Agent host disconnected. Reconnect to continue.';

async function openHostThread(page: Page): Promise<void> {
  const { mockFileSystemOperations } = await loadElectronHelpers();
  await mockFileSystemOperations(page);
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
}

test('the thread pane reconnects to a replaced agent host and never resends', async ({
  electron,
  modelProvider,
}) => {
  test.setTimeout(240_000);
  const page = await electron.ensureWindow();
  await openHostThread(page);
  const hold = Promise.withResolvers<void>();
  modelProvider.setScript(({ messages, toolNames }) => {
    // The title request carries no tools.
    if (toolNames.length === 0) {
      return { finalText: 'Host loss drill' };
    }
    return JSON.stringify(messages).includes(SECOND_PROMPT)
      ? { finalText: SECOND_REPLY }
      : { beforeFinalText: hold.promise, finalText: NEVER, streamedBeforeHold: STREAMING };
  });
  const turnsFor = (prompt: string): number =>
    modelProvider
      .requests()
      .filter(
        ({ messages, toolNames }) =>
          toolNames.length > 0 && JSON.stringify(messages).includes(prompt)
      ).length;
  const userDataDir = electron.getUserDataDir();
  const outcomes = async (): Promise<readonly string[]> =>
    (await readHostThreadTree(userDataDir))
      .filter(({ parentThreadId }) => parentThreadId === undefined)
      .flatMap(({ rows }) =>
        rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
      );
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  try {
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(FIRST_PROMPT);
    await input.press('Enter');
    await expect(region.getByText(STREAMING)).toBeVisible({ timeout: 60_000 });

    // 1. The host dies mid-reply; the pane reconnects to its replacement unasked.
    const lost = await readHostProcess(userDataDir);
    process.kill(lost.pid, 'SIGKILL');
    await expect
      .poll(async () => (await readHostProcess(userDataDir).catch(() => lost)).pid, {
        timeout: 60_000,
      })
      .not.toBe(lost.pid);
    await expect(region.getByText('Reply interrupted', { exact: true })).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.getByText(DISCONNECTED)).toHaveCount(0);
    // The pane shows the new host's committed rows. The killed host never
    // committed the partial reply, which was live telemetry (ADR-0011).
    await expect(region.getByText(FIRST_PROMPT, { exact: true })).toBeVisible();
    await expect(region.getByText(STREAMING)).toHaveCount(0);
    await expect(region.getByText(NEVER, { exact: true })).toHaveCount(0);
    await expect.poll(outcomes, { timeout: 30_000 }).toEqual(['interrupted']);
    expect(turnsFor(FIRST_PROMPT)).toBe(1);

    // The same thread takes a new send on the new host.
    await input.fill(SECOND_PROMPT);
    await input.press('Enter');
    await expect(region.getByText(SECOND_REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(outcomes, { timeout: 30_000 }).toEqual(['interrupted', 'completed']);

    // 2. A second loss before the user reconnects, with a send the host never read.
    const stopped = await readHostProcess(userDataDir);
    process.kill(stopped.pid, 'SIGSTOP');
    await input.fill(UNREAD_PROMPT);
    await input.press('Enter');
    // The composer took the draft: the send is dispatched to a host that cannot read it.
    await expect(input).toHaveValue('', { timeout: 10_000 });
    process.kill(stopped.pid, 'SIGKILL');
    // The connection banner and command alerts sit above the conversation region.
    const reconnect = page.getByRole('button', { exact: true, name: 'Reconnect' });
    await expect(reconnect).toBeVisible({ timeout: 60_000 });
    await reconnect.click();
    await expect(page.getByRole('alert', { name: 'Agent command error' })).toContainText(
      'Not sent: the agent host restarted.',
      { timeout: 60_000 }
    );
    await expect(input).toHaveValue(UNREAD_PROMPT);
    await expect(reconnect).toHaveCount(0);
    expect((await readHostProcess(userDataDir)).pid).not.toBe(stopped.pid);
    await expect.poll(outcomes, { timeout: 30_000 }).toEqual(['interrupted', 'completed']);
    expect(turnsFor(UNREAD_PROMPT)).toBe(0);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    hold.resolve();
  }
});
