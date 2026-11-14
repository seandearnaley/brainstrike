import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest, ScriptedToolCall } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// BST-2531: a run that outgrows its budget part-way through summarizes its
// older steps between two steps, shows a compaction card on the run and
// carries on. The provider reports the run's eighteenth read past the 200,000
// cap. The newest 20,000 estimated tokens stay; the about 33,000 behind them
// are more than one protect window, so summarizing them is worth a call.
const REPLY = 'Every chapter read.';
const READ = 'brainstrike_readWorkspaceFile';
const SUMMARY = 'Goal: g\nState: s\nDecisions: d\nNext: n\nFiles touched: none';
const chapter = (number: number) => `src/chapter-${String(number).padStart(2, '0')}.ts`;
const CHAPTERS = 22;
const FILES = Array.from({ length: CHAPTERS }, (_unused, index) => chapter(index + 1));
// The read whose response reports the request past the cap.
const REPORTED_PAST_CAP = chapter(18);
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-midrun-compaction-')));
mkdirSync(path.join(root, 'src'));
for (const [index, file] of FILES.entries()) {
  // Longer than a read's 12,000 characters: about 3,000 estimated tokens a read.
  const lines = Array.from(
    { length: 250 },
    (_unused, line) => `export const chapter${index + 1}_${line + 1} = '${'x'.repeat(30)}';`
  );
  writeFileSync(path.join(root, file), `${lines.join('\n')}\n`);
}
test.afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

/** The thread's own run, which streams and carries tools; a summary or title does not. */
const threadRun = (request: ModelProviderRequest): boolean =>
  (request.requestBody as { stream?: unknown }).stream === true && request.toolNames.length > 0;

test('a run past its budget part-way through compacts its older steps behind a card and carries on', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(120_000);
  await seedRoot(page, root, { reloadReason: 'midrun-compaction-root', rootId: randomUUID() });
  await configureAssistantProvider(page, {
    apiKey: 'test-key-midrun-compaction',
    compositeModelKey: 'openai::gpt-6-luna',
    provider: 'openai',
  });
  // One call a step, chosen by the run's request count: a compaction takes
  // earlier results out of the request, so they cannot be counted.
  let calls: readonly ScriptedToolCall[] | undefined;
  let step = 0;
  modelProvider.setScript((request) => {
    if (!threadRun(request)) {
      return { finalText: SUMMARY };
    }
    calls ??= [
      ...(request.toolNames.includes(READ)
        ? []
        : [{ arguments: { toolNames: [READ] }, name: 'load_tool' }]),
      ...FILES.map((file) => ({ arguments: { path: file }, name: READ })),
    ];
    const call = calls[step];
    step += 1;
    if (!call) {
      return { finalText: REPLY };
    }
    const pastCap = call.arguments['path'] === REPORTED_PAST_CAP;
    return {
      finalText: REPLY,
      ignorePriorToolResults: true,
      toolCall: call,
      ...(pastCap
        ? {
            responsesUsage: {
              ['input_tokens']: 250_000,
              ['input_tokens_details']: { ['cache_write_tokens']: 0, ['cached_tokens']: 0 },
              ['output_tokens']: 10,
              ['total_tokens']: 250_010,
            },
          }
        : {}),
    };
  });

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Read every chapter.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(region.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 90_000 });

  // The card sits on the run, counts the steps it replaced, and was summarized.
  const card = region.getByTestId('compaction-summary-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-compaction-fallback', 'agentic');
  await expect(card.getByTestId('compaction-summary-reason')).toContainText(
    'Before the request, to keep it inside the context budget'
  );
  await expect(card.getByTestId('compaction-summary-turns').locator('dd')).toHaveText(
    /^\d+ steps$/u
  );

  // Every request after it keeps the question and leaves the replaced reads out.
  const runRequests = modelProvider.requests().filter(threadRun);
  const last = JSON.stringify(runRequests.at(-1)?.messages);
  expect(last).toContain('Read every chapter.');
  expect(last).not.toContain(chapter(1));
  expect(last).toContain(chapter(CHAPTERS));

  // The Context tab marks the compaction on its turn and draws the replaced read as compacted.
  await region.getByTestId('context-usage-trigger').click();
  await page.getByTestId('context-usage-open-context-map').click();
  const context = page.getByTestId('thread-context-page');
  await expect(context).toBeVisible({ timeout: 30_000 });
  await expect(context.getByTestId('context-map-compaction-marker')).toHaveAttribute(
    'title',
    'Compacted into a summary'
  );
  await context
    .getByTestId('context-map-file')
    .filter({ hasText: chapter(1) })
    .click();
  await expect(context.getByTestId('context-map-lens')).toContainText('Compacted into a summary');
  expect(modelProvider.refusals()).toEqual([]);
});
