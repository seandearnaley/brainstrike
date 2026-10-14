import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-rewind';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ORIGINAL = 'original notes\n';
const REWRITTEN = 'rewritten by the host run\n';
const HELLO = 'Hello from the first turn.';
const REWRITE_PROMPT = 'Rewrite the notes.';
const REWRITE_REPLY = 'The notes are rewritten.';
const BRANCH_REPLY = 'A different answer on a new branch.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

async function enableModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
}

/** The rewrite turn writes notes.txt through the native write tool; every other turn only answers. */
function script(request: ModelProviderRequest) {
  // The turn's own prompt: its newest user message (a tool result may follow it).
  const prompt = JSON.stringify(
    request.messages.findLast((message) => (message as { readonly role?: unknown }).role === 'user')
  );
  const write = request.toolNames.find((tool) => tool.endsWith('writeWorkspaceFile'));
  if (prompt.includes(REWRITE_PROMPT) && write) {
    return {
      finalText: REWRITE_REPLY,
      toolCall: { arguments: { content: REWRITTEN, path: 'notes.txt' }, name: write },
    };
  }
  return { finalText: prompt.includes('Something else') ? BRANCH_REPLY : HELLO };
}

test('a host thread restores to before a message, undoes it, and branches from there', async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(360_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-m3-rewind-')));
  const notes = path.join(root, 'notes.txt');
  writeFileSync(notes, ORIGINAL);
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'm3-rewind-root',
      rootId: randomUUID(),
    });
    await enableModel(page);
    modelProvider.setScript(script);
    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    const input = region.getByRole('textbox', { name: 'Message input' });
    const send = async (text: string, reply: string) => {
      await input.fill(text);
      await region.getByRole('button', { exact: true, name: 'Send' }).click();
      await expect(region.getByText(reply)).toBeVisible({ timeout: 90_000 });
    };

    await send('Say hello.', HELLO);
    await input.fill(REWRITE_PROMPT);
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    const approve = region.getByRole('button', { name: /^Approve / });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    await approve.click();
    await expect(region.getByText(REWRITE_REPLY)).toBeVisible({ timeout: 90_000 });
    expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);

    // Restore to before the rewrite: the modal says where the later turn goes,
    // and lists the file the files scope restores.
    const restore = region.getByTestId('message-rewind-action');
    await expect(restore).toHaveCount(2, { timeout: 30_000 });
    await restore.last().click();
    const dialog = page.getByTestId('rewind-confirm-dialog');
    await expect(
      dialog.getByText(
        'The conversation returns to before this message. 1 turn leaves this conversation; switch back to it with the branch picker.'
      )
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('changed-files-tree').getByText('notes.txt')).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByTestId('rewind-mode-conversation-and-files')).toBeChecked();
    await dialog.getByTestId('rewind-confirm').click();
    await expect(dialog.getByTestId('rewind-outcome-messages')).toHaveText(
      '1 turn left this conversation; switch back to it with the branch picker.',
      { timeout: 30_000 }
    );
    await dialog.getByTestId('rewind-done').click();

    // The file is back, the conversation is back before the rewrite, and its
    // prompt waits in the composer.
    await expect.poll(() => readFileSync(notes, 'utf8'), { timeout: 30_000 }).toBe(ORIGINAL);
    await expect(region.getByText(REWRITE_REPLY)).toHaveCount(0);
    await expect(region.getByText(HELLO)).toBeVisible();
    await expect(input).toHaveValue(REWRITE_PROMPT);

    // Undo from the notification: the rewrite and its turn return.
    await page.getByTestId('rewind-undo-toast-action').click();
    await expect.poll(() => readFileSync(notes, 'utf8'), { timeout: 30_000 }).toBe(REWRITTEN);
    await expect(region.getByText(REWRITE_REPLY)).toBeVisible({ timeout: 30_000 });

    // Restore the conversation only, then send something else: it branches
    // from before the rewrite, and the old turn stays one branch away.
    await region.getByTestId('message-rewind-action').last().click();
    await dialog.getByTestId('rewind-mode-conversation-only').check();
    await dialog.getByTestId('rewind-confirm').click();
    await dialog.getByTestId('rewind-done').click();
    expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);
    await input.fill('Something else, please.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(region.getByText(BRANCH_REPLY)).toBeVisible({ timeout: 90_000 });
    await expect(region.getByText(REWRITE_REPLY)).toHaveCount(0);
    await region.getByRole('button', { name: 'Previous branch' }).first().click();
    await expect(region.getByText(REWRITE_REPLY)).toBeVisible({ timeout: 30_000 });
    expect(modelProvider.refusals()).toEqual([]);
  } finally {
    await electron.dispose();
    rmSync(root, { force: true, recursive: true });
  }
});
