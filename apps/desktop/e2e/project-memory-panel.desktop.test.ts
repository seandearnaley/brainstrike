import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoots } from './utils/seed-root';
import { E2E_TIMEOUTS } from './utils/timeouts';
import { trustWorkspaceFromComposer } from './utils/workspace-trust';

const QUESTION = 'Which Node version do the tests need?';
const SAVED = "# Test runtime\nThis repo's tests need Node 26.\n";
const EDITED = "# Test runtime\nThis repo's tests need Node 27.\n";
const EDITED_LINE = "- [Test runtime](test-runtime.md) — This repo's tests need Node 27.";

const streaming = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true;

/** The model answers from whatever its instructions say about the Node version. */
function answer(request: ModelProviderRequest): string {
  const sent = JSON.stringify(request.requestBody);
  if (sent.includes('Node 27')) {
    return 'The tests need Node 27.';
  }
  return sent.includes('Node 26') ? 'The tests need Node 26.' : 'No note says.';
}

/** Opens the Memory panel of the project section named `label`. */
async function openMemory(page: Page, label: string): Promise<Locator> {
  await page.getByRole('button', { exact: true, name: `Project actions ${label}` }).click();
  await page.getByRole('button', { exact: true, name: 'Memory' }).click();
  const memory = page.getByRole('dialog', { name: `${label} · Memory` });
  await expect(memory).toBeVisible();
  return memory;
}

/** Starts a thread in the folder and asks the question; resolves the request that answered it. */
async function ask(
  page: Page,
  conversation: Locator,
  folder: string,
  expected: string,
  requests: () => readonly ModelProviderRequest[]
): Promise<ModelProviderRequest | undefined> {
  await page.getByRole('button', { exact: true, name: 'New thread' }).click();
  await chooseThreadFolder(conversation, folder);
  await conversation.getByRole('textbox', { name: 'Message input' }).fill(QUESTION);
  await conversation.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(conversation.getByText(expected).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  return requests()
    .filter((request) => streaming(request) && JSON.stringify(request.messages).includes(QUESTION))
    .at(-1);
}

/**
 * BST-2534: the person corrects what the assistant saved. The assistant saves
 * a note; the person edits it in the project's Memory panel, and a new thread
 * answers from the edited text; the person deletes it, and a new thread no
 * longer has it.
 */
test("a person edits and deletes a project's note in its Memory panel, and the next thread follows", async ({
  electron,
  modelProvider,
  window,
}) => {
  const folder = join(electron.getWorkspaceRoot(), 'beaker');
  mkdirSync(folder, { mode: 0o755, recursive: true });
  writeFileSync(join(folder, 'AGENTS.md'), '# Conventions\nRun the tests before a commit.\n');
  await seedRoots(window, [{ path: folder, rootId: 'root-project-memory-panel' }], {
    reloadReason: 'BST-2534 project memory panel',
  });
  await configureAssistantProvider(window);
  modelProvider.setScript((request) => {
    if (!streaming(request)) {
      return { finalText: 'Node version' };
    }
    return JSON.stringify(request.messages).includes(QUESTION)
      ? { finalText: answer(request) }
      : {
          finalText: 'Saved.',
          toolCall: {
            arguments: { command: 'create', file_text: SAVED, path: '/memories/test-runtime.md' },
            name: 'brainstrike_memory',
          },
        };
  });
  await ensureAssistantShellVisible(window);
  const conversation = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = conversation.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await chooseThreadFolder(conversation, basename(folder));
  await trustWorkspaceFromComposer(conversation);
  await input.fill("Remember: this repo's tests need Node 26.");
  await conversation.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(conversation.getByTestId('project-memory-note')).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  // The person opens the project's Memory and corrects the note.
  let memory = await openMemory(window, basename(folder));
  await expect(memory.getByRole('option', { name: /Test runtime/u })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  const note = memory.getByRole('textbox', { name: 'Note' });
  await expect(note).toHaveValue(SAVED);
  await note.fill(EDITED);
  await memory.getByRole('button', { exact: true, name: 'Save' }).click();
  await expect(memory.getByRole('button', { exact: true, name: 'Save' })).toBeDisabled();
  // Escape at once: the panel closes once the save lands.
  await window.keyboard.press('Escape');
  await expect(memory).toBeHidden();

  // A new thread in the project starts with the corrected note.
  const edited = await ask(
    window,
    conversation,
    basename(folder),
    'The tests need Node 27.',
    modelProvider.requests
  );
  expect(JSON.stringify(edited?.requestBody)).toContain(EDITED_LINE);

  // The person deletes it, after the panel asks once.
  memory = await openMemory(window, basename(folder));
  await expect(note).toHaveValue(EDITED);
  await memory.getByRole('button', { exact: true, name: 'Delete' }).click();
  await expect(memory.getByText('Delete this note?')).toBeVisible();
  await memory.getByRole('button', { exact: true, name: 'Delete' }).click();
  await expect(memory.getByRole('option')).toHaveCount(0);
  await expect(memory.getByRole('textbox')).toHaveCount(0);
  await window.keyboard.press('Escape');
  await expect(memory).toBeHidden();

  // A new thread no longer has it.
  const deleted = await ask(
    window,
    conversation,
    basename(folder),
    'No note says.',
    modelProvider.requests
  );
  expect(JSON.stringify(deleted?.requestBody)).not.toContain('Test runtime');
  expect(modelProvider.refusals()).toEqual([]);
});
