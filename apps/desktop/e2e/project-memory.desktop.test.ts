import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoots } from './utils/seed-root';
import { E2E_TIMEOUTS } from './utils/timeouts';
import { trustWorkspaceFromComposer } from './utils/workspace-trust';

const QUESTION = 'Which Node version do the tests need?';
const ANSWER = 'The tests need Node 26.';

const streaming = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true;

/**
 * ADR-0040: the assistant saves a note in one thread of a project, the thread
 * shows the save as a card with Undo, and a new thread in the same project
 * starts with the note in its instructions and answers from it.
 */
test('a note saved in one thread is known to the next thread in the same project', async ({
  electron,
  modelProvider,
  window,
}) => {
  // A folder with an AGENTS.md, so the composer asks to trust it (ADR-0032).
  const folder = join(electron.getWorkspaceRoot(), 'beaker');
  mkdirSync(folder, { mode: 0o755, recursive: true });
  writeFileSync(join(folder, 'AGENTS.md'), '# Conventions\nRun the tests before a commit.\n');
  await seedRoots(window, [{ path: folder, rootId: 'root-project-memory' }], {
    reloadReason: 'ADR-0040 project memory',
  });
  await configureAssistantProvider(window);
  modelProvider.setScript((request) => {
    if (!streaming(request)) {
      return { finalText: 'Node version' };
    }
    return JSON.stringify(request.messages).includes(QUESTION)
      ? { finalText: ANSWER }
      : {
          finalText: 'Saved.',
          toolCall: {
            arguments: {
              command: 'create',
              file_text: "# Test runtime\nThis repo's tests need Node 26.\n",
              path: '/memories/test-runtime.md',
            },
            name: 'brainstrike_memory',
          },
        };
  });
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await chooseThreadFolder(panel, basename(folder));
  // Memory loads only for a trusted folder, as its AGENTS.md does.
  await trustWorkspaceFromComposer(panel);

  await input.fill("Remember: this repo's tests need Node 26.");
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText('Saved.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  // The save is a card in the thread: the note, and Undo.
  const card = panel.getByTestId('project-memory-note');
  await expect(card.getByTestId('project-memory-title')).toHaveText('Test runtime');
  await expect(card.getByTestId('project-memory-text')).toHaveText(
    "This repo's tests need Node 26."
  );
  await expect(card.getByTestId('project-memory-undo')).toBeVisible();
  await expect(card.getByTestId('project-memory-untrusted')).toHaveCount(0);

  // A new thread in the same project starts knowing the note.
  await window.getByRole('button', { exact: true, name: 'New thread' }).click();
  await chooseThreadFolder(panel, basename(folder));
  await input.fill(QUESTION);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(ANSWER).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  const turns = modelProvider.requests().filter(streaming);
  expect(turns[0]?.toolNames).toContain('brainstrike_memory');
  const asked = turns.filter((turn) => JSON.stringify(turn.messages).includes(QUESTION)).at(-1);
  expect(JSON.stringify(asked?.requestBody)).toContain(
    "- [Test runtime](test-runtime.md) — This repo's tests need Node 26."
  );
  expect(modelProvider.refusals()).toEqual([]);
});
