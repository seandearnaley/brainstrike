/**
 * Desktop E2E (BST-1990 PR 3, the #3572 smoke's K11): a checked file in a
 * workspace folder outside the thread reaches the model as attached content,
 * marked as coming from outside the thread's folders, and the Files card says
 * so. "Add to this thread" makes that folder a thread folder, after which the
 * agent's tools may read its other files. The thread's binding, not the
 * explorer's focus, decides which folders the agent can use.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords, readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';

const API_KEY = 'test-key-host-checked-files';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const CHECKED_MARKER = 'BRAVO_CHECKED_MARKER_1990';
const OTHER_MARKER = 'BRAVO_OTHER_MARKER_1990';
const OUTSIDE_MARK = 'not one of this thread';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

function isUserMessage(message: unknown): boolean {
  return Boolean(
    message && typeof message === 'object' && 'role' in message && message.role === 'user'
  );
}

function lastUserMessage({ messages }: ModelProviderRequest): string {
  return JSON.stringify(messages.filter(isUserMessage).at(-1));
}

/** What the model received after the turn's user message: its tool results. */
function currentTurnResults({ messages }: ModelProviderRequest): string {
  const lastUser = messages.findLastIndex(isUserMessage);
  return JSON.stringify(messages.slice(lastUser + 1));
}

/** The durable `roots.id` of a mounted folder, from the app's own database. */
async function rootIdOf(page: Page, rootPath: string): Promise<string> {
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  const rows = (await readHostRootRecords(userData)).filter((root) => root.path === rootPath);
  if (rows.length !== 1 || !rows[0]) {
    throw new Error(`Expected one canonical root for ${rootPath}`);
  }
  return rows[0].id;
}

test('a checked file outside the thread reaches the model marked, and Add to this thread grants its folder', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  writeFileSync(path.join(alphaRoot, 'alpha-only.txt'), 'alpha\n');
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-checked-files-')));
  const bravoName = path.basename(bravoRoot);
  writeFileSync(path.join(bravoRoot, 'bravo-checked.txt'), `${CHECKED_MARKER}\n`);
  writeFileSync(path.join(bravoRoot, 'bravo-other.txt'), `${OTHER_MARKER}\n`);
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-only.txt').first()).toBeVisible({ timeout: 60_000 });
    await enableModel(page);
    const seen = { checked: false, marked: false, other: false, otherRefused: false };
    modelProvider.setScript((request) => {
      const turn = /CHECKED_TURN_(\d)/u.exec(lastUserMessage(request))?.[1];
      const results = currentTurnResults(request);
      if (turn === '0') {
        return { finalText: 'CHECKED_REPLY_0' };
      }
      if (turn === '1') {
        seen.checked ||= results.includes(CHECKED_MARKER);
        seen.marked ||= results.includes(OUTSIDE_MARK);
        // The selection's default read: no paths, no root.
        return {
          deferredTool: true,
          finalText: 'CHECKED_REPLY_1',
          toolCall: { arguments: {}, name: 'brainstrike_readWorkspaceContext' },
        };
      }
      if (turn === '2') {
        seen.other ||= results.includes(OTHER_MARKER);
        seen.otherRefused ||= results.includes('tool_input_invalid');
        return {
          finalText: 'CHECKED_REPLY_2',
          toolCall: {
            arguments: { path: 'bravo-other.txt', root: bravoName },
            name: 'brainstrike_readWorkspaceFile',
          },
        };
      }
      return { finalText: 'Checked files' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (turn: number): Promise<void> => {
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(`CHECKED_TURN_${turn}: use the selected context`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(`CHECKED_REPLY_${turn}`)).toBeVisible({ timeout: 90_000 });
    };

    // The thread binds folder A on its first run.
    await send(0);
    const alphaId = await rootIdOf(page, alphaRoot);

    // Folder B joins the workspace, not the thread, and one of its files is checked.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-checked.txt').first()).toBeVisible({ timeout: 60_000 });
    const bravoId = await rootIdOf(page, bravoRoot);
    await page
      .getByRole('treegrid', { name: 'File tree' })
      .getByRole('checkbox', { name: 'Select bravo-checked.txt' })
      .click();

    // The file reaches the model, marked as coming from outside the thread.
    await send(1);
    expect(seen).toMatchObject({ checked: true, marked: true });

    // The Files card says where it comes from, and offers to add the folder.
    const notice = page.getByTestId(`tapestry-thread-notice-${bravoId}`).first();
    await expect(notice).toContainText(`from ${bravoName}, not in this thread`);
    await notice.getByRole('button', { name: 'Add to this thread' }).click();
    await expect(page.getByTestId(`tapestry-thread-notice-${bravoId}`)).toHaveCount(0, {
      timeout: 30_000,
    });

    // Now B is a thread folder, so a tool read of another of its files succeeds.
    await send(2);
    expect(seen).toMatchObject({ other: true, otherRefused: false });
    const root = (await readHostThreadTree(electron.getUserDataDir())).find(
      ({ parentThreadId }) => parentThreadId === undefined
    );
    if (!root) {
      throw new Error('The host committed no root thread');
    }
    const { binding } = await withAppHost(electron.getUserDataDir(), async (client) =>
      client.request('thread/workspace/binding/read', { threadId: root.threadId })
    );
    expect(binding?.operatingRootId).toBe(alphaId);
    expect(binding?.secondaryRootIds).toEqual([bravoId]);
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
