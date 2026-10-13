/**
 * Desktop E2E (BST-1984): a host thread keeps sending after a second folder is
 * added to the workspace. Adding a folder focuses it in the explorer, but the
 * thread's Core binding owns the root its runs execute in; the explorer focus
 * only scopes the user's selection. A send, a reload and opening the Changes
 * tab must all leave the thread running in its bound root.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords, readHostThreadTree, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';

const API_KEY = 'test-key-host-second-root-send';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ALPHA_MARKER = 'ALPHA_ONLY_MARKER_1984';
const TURNS = [1, 2, 3] as const;
const REFUSAL = 'The selected workspace root is no longer mounted';

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

/**
 * Focus a workspace folder in the explorer, as any click inside its section does.
 * Its header toggles the section, so a second click re-expands it.
 */
async function focusFolder(page: Page, name: string): Promise<void> {
  const row = page.getByTestId('root-section-header-row').filter({ hasText: name });
  if ((await row.getAttribute('data-focused')) !== 'true') {
    const header = row.getByTestId('root-section-header');
    await header.click();
    await header.click();
  }
  await expect(row).toHaveAttribute('data-focused', 'true');
  await expect(row.getByTestId('root-section-header')).toHaveAttribute('aria-expanded', 'true');
}

test('a host thread sends after a second folder is added, across a reload and the Changes tab', async ({
  electron,
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(300_000);
  // Folder A is the folder the harness's picker mounts first; folder B is added second.
  const alphaRoot = await electronApp.app.evaluate(
    () => process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] ?? ''
  );
  expect(alphaRoot).not.toBe('');
  // One file per turn: a repeated read of an unchanged file returns a dedup stub.
  for (const turn of TURNS) {
    writeFileSync(path.join(alphaRoot, `alpha-${turn}.txt`), `${ALPHA_MARKER}_${turn}\n`);
  }
  const bravoRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m6-second-root-')));
  writeFileSync(path.join(bravoRoot, 'bravo-only.txt'), 'bravo\n');
  try {
    await ensureMockWorkspaceOpen(page);
    await expect(page.getByText('alpha-1.txt').first()).toBeVisible({ timeout: 60_000 });
    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, bravoRoot);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo-only.txt').first()).toBeVisible({ timeout: 60_000 });
    const alphaId = await rootIdOf(page, alphaRoot);
    const bravoId = await rootIdOf(page, bravoRoot);

    await enableModel(page);
    // Each turn reads its alpha file with no `root`: it resolves to the thread's bound folder.
    const alphaReads = new Set<string>();
    modelProvider.setScript((request) => {
      const prompt = lastUserMessage(request);
      const turn = /SECOND_ROOT_TURN_(\d)/u.exec(prompt)?.[1];
      if (!turn) {
        return { finalText: 'Second root' };
      }
      if (currentTurnResults(request).includes(`${ALPHA_MARKER}_${turn}`)) {
        alphaReads.add(turn);
      }
      return {
        finalText: `SECOND_ROOT_REPLY_${turn}`,
        toolCall: {
          arguments: { path: `alpha-${turn}.txt` },
          name: 'brainstrike_readWorkspaceFile',
        },
      };
    });
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const send = async (turn: number): Promise<void> => {
      // Folder B is focused at every send, as after adding it and after the reload in BST-1984.
      await focusFolder(page, path.basename(bravoRoot));
      await region
        .getByRole('textbox', { name: 'Message input' })
        .fill(`SECOND_ROOT_TURN_${turn}: read alpha-${turn}.txt`);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(`SECOND_ROOT_REPLY_${turn}`)).toBeVisible({
        timeout: 90_000,
      });
      await expect(region.getByText(REFUSAL)).toHaveCount(0);
    };

    await send(1);

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'bst-1984-second-root-reload');
    await ensureAssistantShellVisible(page);
    await send(2);

    await page.getByTestId('workspace-add-tab').click();
    await page.getByTestId('workspace-add-tab-changes').click();
    await expect(page.getByTestId('changes-surface')).toBeVisible({ timeout: 30_000 });
    await ensureAssistantShellVisible(page);
    await send(3);

    // Each turn read the bound folder's file, and every run ran on the thread's binding.
    expect([...alphaReads].sort()).toEqual(TURNS.map(String));
    const userDataDir = electron.getUserDataDir();
    const root = (await readHostThreadTree(userDataDir)).find(
      ({ parentThreadId }) => parentThreadId === undefined
    );
    if (!root) {
      throw new Error('The host committed no root thread');
    }
    const binding = await withAppHost(userDataDir, async (client) =>
      client.request('thread/workspace/binding/read', { threadId: root.threadId })
    );
    expect(binding.binding?.operatingRootId).toBe(alphaId);
    const started = root.rows.flatMap(({ event }) =>
      event.type === 'run.started' ? [event.snapshot] : []
    );
    expect(started).toHaveLength(3);
    for (const snapshot of started) {
      // The explorer proposed folder B; the run executed in the thread's one folder, A.
      expect(snapshot?.configuration['intent']).toMatchObject({ selectionFolderId: bravoId });
      expect(snapshot?.workspaceBinding?.operatingRootId).toBe(alphaId);
      expect(snapshot?.configuration['boundWorkspaceRoots']).toMatchObject([
        { path: alphaRoot, rootId: alphaId },
      ]);
    }
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(bravoRoot, { force: true, recursive: true });
  }
});
