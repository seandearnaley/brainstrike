import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

const API_KEY = 'test-key-host-turn-revert';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
const ORIGINAL = 'original notes\n';
const REWRITTEN = 'rewritten by the host run\n';
const REPLY = 'The notes are rewritten.';

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

/** One scripted write through the native write tool, then a final answer. */
function writeScript(request: ModelProviderRequest) {
  const name = request.toolNames.find((tool) => tool.endsWith('writeWorkspaceFile'));
  return name
    ? { finalText: REPLY, toolCall: { arguments: { content: REWRITTEN, path: 'notes.txt' }, name } }
    : { finalText: `No write tool offered: ${request.toolNames.join(', ')}` };
}

test("a turn's file reverts whole from its Changes view, back to before the turn", async ({
  electron,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(240_000);
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-turn-revert-')));
  electron.removeAfterClose(root);
  const notes = path.join(root, 'notes.txt');
  writeFileSync(notes, ORIGINAL);
  await seedRoot(page, root, { reloadReason: 'turn-revert-root', rootId: randomUUID() });
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await enableAssistantCatalogModel(page, `openrouter::${MODEL}`);
  modelProvider.setScript(writeScript);
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Rewrite the notes.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await region.getByRole('button', { name: /^Approve /u }).click({ timeout: 90_000 });
  await expect(region.getByText(REPLY)).toBeVisible({ timeout: 90_000 });
  expect(readFileSync(notes, 'utf8')).toBe(REWRITTEN);
  await region
    .getByRole('region', { name: 'Changes from this turn' })
    .getByRole('button', { exact: true, name: 'Review' })
    .click({ timeout: 30_000 });

  // The file offers Revert on its header and in the toolbar, never on a hunk.
  const surface = page.getByTestId('changes-surface');
  const diff = surface.getByTestId('diff-review');
  await expect(diff.getByText(REWRITTEN.trim())).toBeVisible({ timeout: 30_000 });
  await expect(surface.getByRole('button', { exact: true, name: 'Revert all' })).toBeVisible();
  await expect(diff.getByRole('button', { exact: true, name: 'Revert' })).toHaveCount(0);

  await diff.getByRole('button', { name: 'Revert notes.txt' }).click();
  await page
    .getByRole('alertdialog', { name: 'Revert notes.txt?' })
    .getByRole('button', { exact: true, name: 'Revert' })
    .click();

  // The file is back as it was before the turn; the turn still shows what it did,
  // and offers no revert of a file the turn's change is gone from.
  await expect.poll(() => readFileSync(notes, 'utf8'), { timeout: 30_000 }).toBe(ORIGINAL);
  await expect(diff.getByRole('button', { name: 'Revert notes.txt' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(surface.getByRole('button', { exact: true, name: 'Revert all' })).toHaveCount(0);
  await expect(diff.getByText(REWRITTEN.trim())).toBeVisible();
  expect(modelProvider.refusals()).toEqual([]);
});
