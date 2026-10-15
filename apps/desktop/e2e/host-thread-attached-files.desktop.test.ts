/**
 * Desktop E2E (BST-2018, ADR-0021): "Attach to thread" from the Files app. A
 * file selected in a workspace folder outside the thread becomes an `@file`
 * mention in the composer; sent, it reaches the model as attached content
 * marked as coming from outside the thread's folders, and the notice says so.
 * "Add to this thread" then makes the folder a thread folder, after which the
 * agent's tools may read its other files.
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

const API_KEY = 'test-key-host-attached-files';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ATTACHED_MARKER = 'BRAVO_ATTACHED_MARKER_2018';
const OTHER_MARKER = 'BRAVO_OTHER_MARKER_2018';
const OUTSIDE_MARK = "not one of this thread's folders; attached for this run only";

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

test('a file attached from outside the thread reaches the model marked, and Add to this thread grants its folder', async ({
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
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-attached-files-')));
  const bravoName = path.basename(bravoRoot);
  writeFileSync(path.join(bravoRoot, 'bravo-attached.txt'), `${ATTACHED_MARKER}\n`);
  writeFileSync(path.join(bravoRoot, 'bravo-other.txt'), `${OTHER_MARKER}\n`);
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-only.txt').first()).toBeVisible({ timeout: 60_000 });
    await enableModel(page);
    const seen = { attached: false, marked: false, other: false, otherRefused: false };
    modelProvider.setScript((request) => {
      const turn = /ATTACH_TURN_(\d)/u.exec(lastUserMessage(request))?.[1];
      if (turn === '0') {
        return { finalText: 'ATTACH_REPLY_0' };
      }
      if (turn === '1') {
        // The attached file arrives with the run's context, not through a tool.
        const context = JSON.stringify(request.messages);
        seen.attached ||= context.includes(ATTACHED_MARKER);
        seen.marked ||= context.includes(OUTSIDE_MARK);
        return { finalText: 'ATTACH_REPLY_1' };
      }
      if (turn === '2') {
        const results = currentTurnResults(request);
        seen.other ||= results.includes(OTHER_MARKER);
        seen.otherRefused ||= results.includes('tool_input_invalid');
        return {
          finalText: 'ATTACH_REPLY_2',
          toolCall: {
            arguments: { path: 'bravo-other.txt', root: bravoName },
            name: 'brainstrike_readWorkspaceFile',
          },
        };
      }
      return { finalText: 'Attached files' };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = region.getByRole('textbox', { name: 'Message input' });
    const submit = async (turn: number): Promise<void> => {
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(`ATTACH_REPLY_${turn}`)).toBeVisible({ timeout: 90_000 });
    };
    const send = async (turn: number, text: string): Promise<void> => {
      await input.fill(text);
      await submit(turn);
    };

    // The thread binds folder A on its first run.
    await send(0, 'ATTACH_TURN_0: start');
    const alphaId = await rootIdOf(page, alphaRoot);

    // Folder B joins the workspace, not the thread; one of its files is attached.
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-attached.txt').first()).toBeVisible({ timeout: 60_000 });
    const bravoId = await rootIdOf(page, bravoRoot);
    await page
      .getByRole('treegrid', { name: 'File tree' })
      .getByRole('checkbox', { name: 'Select bravo-attached.txt' })
      .click();
    await page.getByTestId('explorer-attach-to-thread').click();

    // The mention is in the draft, and the notice says the folder is outside the thread.
    const directive = `:file[bravo-attached.txt]{name=${bravoId}::bravo-attached.txt}`;
    await expect(input).toHaveValue(directive);
    const notice = page.locator('li').filter({ hasText: `${bravoName} is not in this thread` });
    await expect(notice).toBeVisible();

    // Sent as attached, the file reaches the model, marked as from outside the thread.
    await input.focus();
    // The draft wraps: Control+End reaches its end, past the whole directive.
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' ATTACH_TURN_1: compare it');
    await submit(1);
    expect(seen).toMatchObject({ attached: true, marked: true });

    // The notice's action makes B a thread folder.
    await notice.getByRole('button', { name: 'Add to this thread' }).click();
    await expect
      .poll(
        async () => {
          const root = (await readHostThreadTree(electron.getUserDataDir())).find(
            ({ parentThreadId }) => parentThreadId === undefined
          );
          if (!root) {
            return;
          }
          const { binding } = await withAppHost(electron.getUserDataDir(), async (client) =>
            client.request('thread/workspace/binding/read', { threadId: root.threadId })
          );
          return binding;
        },
        { timeout: 30_000 }
      )
      .toMatchObject({ operatingRootId: alphaId, secondaryRootIds: [bravoId] });

    // Now B is a thread folder, so a tool read of another of its files succeeds.
    await send(2, 'ATTACH_TURN_2: read the other file');
    expect(seen).toMatchObject({ other: true, otherRefused: false });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
