import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import {
  ensureAssistantShellVisible,
  ensureMockWorkspaceOpen,
  waitForDatabaseReady,
} from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const ENABLED = 'RESET_RELEASE_ENABLED';
const DISABLED = 'RESET_RELEASE_DISABLED';
const RESTORED = 'RESET_RELEASE_RESTORED';
const CHILD_TASK = 'RESET_CHILD_TASK';
const CHILD_REPLY = 'Reset child durable evidence';
const ROOT_REPLY = 'Reset root received its child';
const FOLLOWUP = 'RESET_CHILD_FOLLOWUP';
const FOLLOWUP_REPLY = 'Reset child continuation evidence';
const LEDGER = 'Background invocations of this turn';

test.use({ electronEnv: { BRAINSTRIKE_OPENAI_API_KEY: 'offline-reset-fixture' } });

test.describe('@destructive', () => {
  async function openSubagents(page: Page): Promise<void> {
    await new HomePage(page).openSettings();
    await new SettingsPage(page).openCategory(/Subagents/i, 'subagents');
  }

  async function send(page: Page, prompt: string, response: string): Promise<void> {
    await ensureAssistantShellVisible(page);
    const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
    await panel.getByRole('textbox', { name: 'Message input' }).fill(prompt);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(response, { exact: true }).last()).toBeVisible({
      timeout: E2E_TIMEOUTS.messageVisibility,
    });
  }

  async function confirmReset(page: Page, confirmed: boolean): Promise<void> {
    await page.evaluate((confirmed) => {
      const original = window.confirm;
      window.confirm = () => {
        window.confirm = original;
        return confirmed;
      };
    }, confirmed);
    await page.getByTestId('factory-reset-button').click();
  }

  /** BST-1959: exercise current host truth through actual runs, never legacy SQL seed rows. */
  test('Settings disables actual delegation tools and factory reset removes delegated state @destructive @desktop-ipc-reset', async ({
    electron,
    modelProvider,
  }, testInfo) => {
    const catalogs = new Map<string, readonly string[]>();
    modelProvider.setScript(({ messages, requestBody, toolNames }) => {
      if ((requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: 'Delegated reset root' };
      }
      const history = JSON.stringify(messages);
      const latest = JSON.stringify(
        messages.findLast(
          (value) => value && typeof value === 'object' && 'role' in value && value.role === 'user'
        )
      );
      const marker = [ENABLED, DISABLED, RESTORED].find((value) => latest?.includes(value));
      if (marker) {
        catalogs.set(marker, [...toolNames]);
        return { finalText: `${marker} complete` };
      }
      if (toolNames.includes('agent-explore')) {
        return history.includes(LEDGER) || history.includes('<child_continuation_result>')
          ? { finalText: ROOT_REPLY }
          : {
              finalText: 'Starting the reset child.',
              toolCall: { arguments: { prompt: CHILD_TASK }, name: 'agent-explore' },
            };
      }
      return { finalText: history.includes(FOLLOWUP) ? FOLLOWUP_REPLY : CHILD_REPLY };
    });
    let page = await electron.ensureWindow();
    const app = (await electron.ensureContext()).app;
    const workspace = await app.evaluate(() => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH']);
    if (!workspace) {
      throw new Error('Disposable workspace is missing');
    }
    const sentinel = path.join(workspace, 'keep-user-workspace.txt');
    await writeFile(sentinel, 'USER_WORKSPACE_MUST_SURVIVE_RESET\n');
    const readTree = () => readHostThreadTree(electron.getUserDataDir());
    try {
      await ensureMockWorkspaceOpen(page);
      await configureAssistantProvider(page, {
        apiKey: 'offline-reset-fixture',
        compositeModelKey: 'openai::gpt-6-sol',
        provider: 'openai',
      });
      await send(page, ENABLED, `${ENABLED} complete`);
      expect(catalogs.get(ENABLED)).toContain('agent-worker');
      await send(page, 'Delegate one reset child', ROOT_REPLY);
      await expect
        .poll(
          async () =>
            (await readTree()).filter((thread) => thread.parentThreadId !== undefined).length
        )
        .toBe(1);
      const child = (await readTree()).find((thread) => thread.parentThreadId !== undefined);
      if (!child?.child) {
        throw new Error('The real host child is missing');
      }
      const callSign = child.child.callSign;
      const rootPanel = page.getByRole('region', { exact: true, name: 'Assistant' });
      await rootPanel.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
      await rootPanel
        .getByRole('button', { exact: true, name: `Open ${callSign} conversation` })
        .click();
      const childPanel = page.getByRole('region', { exact: true, name: callSign });
      await expect(childPanel.getByText(CHILD_REPLY, { exact: true })).toBeVisible();
      await childPanel.getByRole('textbox', { name: 'Message input' }).fill(FOLLOWUP);
      await childPanel.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(childPanel.getByText(FOLLOWUP_REPLY, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('tab', { exact: true, name: callSign })).toBeVisible();
      await expect(
        page
          .getByRole('region', { exact: true, name: callSign })
          .getByText(FOLLOWUP_REPLY, { exact: true })
      ).toBeVisible();
      await openSubagents(page);
      const toggle = page.getByTestId('subagent-delegation-toggle');
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await send(page, DISABLED, `${DISABLED} complete`);
      expect(catalogs.get(DISABLED)?.filter((name) => name.startsWith('agent-'))).toEqual([]);
      expect(catalogs.get(DISABLED)).toContain('search_tools');
      await new HomePage(page).openSettings();
      await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
      await expect
        .poll(async () => {
          const tree = await readTree();
          return tree.every(({ rows }) =>
            rows.every(
              ({ event }) =>
                event.type !== 'run.started' ||
                rows.some(
                  ({ event: terminal }) =>
                    terminal.type === 'run.finished' && terminal.runId === event.runId
                )
            )
          );
        })
        .toBe(true);
      const before = await readTree();
      expect(before.some((thread) => thread.threadId === child.threadId)).toBe(true);
      expect(child.rows.some(({ event }) => event.type === 'run.finished')).toBe(true);
      const outcomes = before.flatMap(({ rows }) =>
        rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event.outcome] : []))
      );
      expect(outcomes.length).toBeGreaterThan(4);
      expect(outcomes.every((outcome) => outcome === 'completed')).toBe(true);
      await confirmReset(page, false);
      expect(await readTree()).toEqual(before);
      await openSubagents(page);
      await expect(page.getByTestId('subagent-delegation-toggle')).toHaveAttribute(
        'aria-checked',
        'false'
      );
      await new SettingsPage(page).openCategory(/Factory Reset/i, 'factory-reset');
      const reloaded = page.waitForEvent('load');
      await confirmReset(page, true);
      await reloaded;
      await waitForDatabaseReady(page);
      const oldIds = new Set(before.map((thread) => thread.threadId));
      const assertCleared = async (): Promise<void> => {
        // Main starts the agent host without awaiting it (acquireProfile at boot), so a
        // ready database does not mean the host has published its record. Wait until the
        // host answers, then read what it committed.
        await expect
          .poll(() =>
            readTree().then(
              () => 'answering',
              (error: unknown) => String(error)
            )
          )
          .toBe('answering');
        expect((await readTree()).filter((thread) => oldIds.has(thread.threadId))).toEqual([]);
        await expect(page.getByRole('tab', { exact: true, name: callSign })).toHaveCount(0);
        await openSubagents(page);
        await expect(page.getByTestId('subagent-delegation-toggle')).toHaveAttribute(
          'aria-checked',
          'true'
        );
        expect(await readFile(sentinel, 'utf8')).toBe('USER_WORKSPACE_MUST_SURVIVE_RESET\n');
      };
      await assertCleared();
      page = (await electron.restart()).window;
      await waitForDatabaseReady(page);
      await assertCleared();
      await ensureMockWorkspaceOpen(page);
      await configureAssistantProvider(page, {
        apiKey: 'offline-reset-fixture',
        compositeModelKey: 'openai::gpt-6-sol',
        provider: 'openai',
      });
      await send(page, RESTORED, `${RESTORED} complete`);
      expect(catalogs.get(RESTORED)).toContain('agent-worker');
      expect(modelProvider.refusals()).toEqual([]);
    } finally {
      await testInfo.attach('delegation-provider-catalogs', {
        body: JSON.stringify(Object.fromEntries(catalogs)),
        contentType: 'application/json',
      });
    }
  });
});
