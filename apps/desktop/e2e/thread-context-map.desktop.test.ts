import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ScriptedToolCall } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// ADR-0021 (BST-2017): the Context tab shows what the thread's model received,
// folded from the committed host log, and links from the composer popover.
const REPLY = 'Context tour finished.';
const ALPHA = 'src/alpha.ts';
const BETA = 'src/beta.ts';
const READ = 'brainstrike_readWorkspaceFile';
const GREP = 'brainstrike_grepSearch';
const EDIT = 'brainstrike_stringReplaceWorkspaceFile';
const lines = (name: string, count: number) =>
  Array.from(
    { length: count },
    (_unused, index) => `export const ${name}${index + 1} = ${index + 1};`
  );
const STAGES: readonly (readonly ScriptedToolCall[])[] = [
  [{ arguments: { endLine: 20, path: ALPHA, startLine: 1 }, name: READ }],
  [{ arguments: { endLine: 40, path: ALPHA, startLine: 21 }, name: READ }],
  [{ arguments: { outputMode: 'content', pattern: 'beta3 =' }, name: GREP }],
  // Line 25 of beta was never delivered: the map flags the edit as unread.
  [
    {
      arguments: {
        newStr: 'export const beta25 = 250;',
        oldStr: 'export const beta25 = 25;',
        path: BETA,
      },
      name: EDIT,
    },
  ],
  [{ arguments: { endLine: 10, path: ALPHA, startLine: 1 }, name: READ }],
];
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-context-map-')));
mkdirSync(path.join(root, 'src'));
writeFileSync(path.join(root, ALPHA), `${lines('alpha', 60).join('\n')}\n`);
writeFileSync(path.join(root, BETA), `${lines('beta', 30).join('\n')}\n`);
test.afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

test('the Context tab shows the files a thread received and edited, the same figure as the popover, and a file changed since read', async ({
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(240_000);
  await seedRoot(page, root, {
    disableBackgroundIndexing: true,
    reloadReason: 'context-map-root',
    rootId: randomUUID(),
  });
  await configureAssistantProvider(page, {
    apiKey: 'test-key-context-map',
    compositeModelKey: 'openai::gpt-6-luna',
    provider: 'openai',
  });
  // Stages are chosen by the count of tool results, so the deferred tools to
  // load are fixed by the run's first request (later requests offer them).
  let stages: readonly (readonly ScriptedToolCall[])[] | undefined;
  modelProvider.setScript((request) => {
    if ((request.requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Context tour' };
    }
    if (!stages) {
      const deferred = [READ, GREP, EDIT].filter((name) => !request.toolNames.includes(name));
      stages =
        deferred.length > 0
          ? [[{ arguments: { toolNames: deferred }, name: 'load_tool' }], ...STAGES]
          : STAGES;
    }
    return { finalText: REPLY, toolCallStages: stages };
  });

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Tour alpha and beta.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  // The edit asks first; approve it as it comes.
  const reply = region.getByText(REPLY, { exact: true });
  const approve = region.getByRole('button', { name: /^Approve / });
  await expect(async () => {
    if (await reply.isVisible()) {
      return;
    }
    if (await approve.first().isVisible()) {
      await approve.first().click();
    }
    await expect(reply).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 120_000 });
  expect(readFileSync(path.join(root, BETA), 'utf8')).toContain('export const beta25 = 250;');

  // The popover's files row and the tab's header read the same fold.
  await region.getByTestId('context-usage-trigger').focus();
  const filesRow = page.getByTestId('context-usage-workspace-files');
  await expect(filesRow).toBeVisible();
  const popoverFigure = (await filesRow.textContent())?.match(/~[\d.]+K?/u)?.[0];
  expect(popoverFigure).toBeTruthy();
  await page.getByTestId('context-usage-open-context-map').click();

  const context = page.getByTestId('thread-context-page');
  await expect(context).toBeVisible({ timeout: 30_000 });
  await expect(context.getByTestId('context-map-window-tokens')).toHaveText(
    `${popoverFigure} tokens`
  );
  const files = context.getByTestId('context-map-file');
  await expect(files).toHaveCount(2);
  await expect(files.filter({ hasText: ALPHA })).toHaveCount(1);
  await expect(files.filter({ hasText: BETA })).toHaveCount(1);
  await expect(context.getByTestId('context-map-ring')).toBeVisible();
  await expect(context.getByTestId('context-map-signals')).toContainText(
    `Edited without reading: ${BETA}`
  );

  // The lens lists every delivery of alpha, and compares it with the file on disk.
  await files.filter({ hasText: ALPHA }).click();
  const lens = context.getByTestId('context-map-lens');
  await expect(lens.locator('tbody tr')).toHaveCount(3);
  await expect(context.getByTestId('context-map-lens-freshness')).toHaveText(
    'Compared with the current file',
    { timeout: 30_000 }
  );
  await expect(context.getByTestId('context-map-changed-since-read')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('context-map.png') });

  const changed = lines('alpha', 60);
  changed[4] = 'export const alpha5 = 500;';
  writeFileSync(path.join(root, ALPHA), `${changed.join('\n')}\n`);
  await expect(context.getByTestId('context-map-changed-since-read')).toHaveText(
    `Changed since read: ${ALPHA}`,
    { timeout: 30_000 }
  );
  await expect(lens.locator('[data-freshness="changed"]')).toHaveCount(2);
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('context-map-changed.png'),
  });
  expect(modelProvider.refusals()).toEqual([]);
});
