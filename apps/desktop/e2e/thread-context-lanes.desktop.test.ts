import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ScriptedToolCall } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// BST-2021: the Context tab shows a thread's subagent as its own lane, folded
// from the subagent's own committed log. Only the provider is scripted.
const TASK = 'LANE_TASK: read the top of src/alpha.ts.';
const LEDGER = 'Background invocations of this turn';
const PARENT_DONE = 'Parent read the lane child.';
const CHILD_DONE = 'Lane child read alpha.';
const ALPHA = 'src/alpha.ts';
const READ = 'brainstrike_readWorkspaceFile';
const CALL_SIGN = /^[A-Z][a-z]+-[a-f0-9]{6}/u;
const READ_ALPHA: readonly ScriptedToolCall[] = [
  { arguments: { endLine: 12, path: ALPHA, startLine: 1 }, name: READ },
];

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-context-lanes-')));
mkdirSync(path.join(root, 'src'));
writeFileSync(
  path.join(root, ALPHA),
  `${Array.from({ length: 30 }, (_unused, index) => `export const alpha${index + 1} = ${index + 1};`).join('\n')}\n`
);
test.afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

test("the Context tab shows a subagent's own reads as its lane, and opens its conversation", async ({
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(240_000);
  await seedRoot(page, root, {
    disableBackgroundIndexing: true,
    reloadReason: 'context-lanes-root',
    rootId: randomUUID(),
  });
  await configureAssistantProvider(page, {
    apiKey: 'test-key-context-lanes',
    compositeModelKey: 'openai::gpt-6-luna',
    provider: 'openai',
  });
  // The child's stages are fixed by its first request: a deferred read tool is
  // loaded first.
  let childStages: readonly (readonly ScriptedToolCall[])[] | undefined;
  modelProvider.setScript(({ messages, requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Lane thread' };
    }
    const history = JSON.stringify(messages);
    if (toolNames.includes('agent-explore')) {
      return history.includes(LEDGER)
        ? { finalText: PARENT_DONE }
        : {
            finalText: 'Parent continues while Explorer reads.',
            toolCall: { arguments: { prompt: TASK }, name: 'agent-explore' },
          };
    }
    childStages ??= toolNames.includes(READ)
      ? [READ_ALPHA]
      : [[{ arguments: { toolNames: [READ] }, name: 'load_tool' }], READ_ALPHA];
    return { finalText: CHILD_DONE, toolCallStages: childStages };
  });

  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  await region.getByRole('textbox', { name: 'Message input' }).fill('Ask Explorer to read alpha.');
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  // The parent wakes once with the child's result.
  await expect(region.getByText(PARENT_DONE, { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });

  await region.getByTestId('context-usage-trigger').focus();
  await page.getByTestId('context-usage-open-context-map').click();
  const context = page.getByTestId('thread-context-page');
  await expect(context).toBeVisible({ timeout: 30_000 });
  await expect(context.getByTestId('context-map-title')).toHaveText(
    "What this thread's model received"
  );
  // The parent itself read no file; the subagent's read is its own lane.
  await expect(context.getByTestId('context-map-file')).toHaveCount(0);
  const lanes = context.getByRole('tablist', { name: 'Lanes' });
  const lane = lanes.getByRole('tab', { name: CALL_SIGN });
  await expect(lane).toBeVisible({ timeout: 30_000 });
  await expect(lane).toContainText(/~[\d.]+K? tokens$/u);
  const callSign = (await lane.innerText()).match(CALL_SIGN)?.[0] ?? '';
  expect(callSign).not.toBe('');
  await lane.click();

  await expect(context.getByTestId('context-map-title')).toHaveText(
    `What ${callSign}'s model received`
  );
  const files = context.getByTestId('context-map-file');
  await expect(files).toHaveCount(1);
  await expect(files.filter({ hasText: ALPHA })).toHaveCount(1);
  await expect(context.getByText(/As of turn 1 of 1 \(latest\)/u)).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('context-lane.png') });

  // The lane opens the subagent's own conversation in its workspace tab.
  await context.getByTestId('context-map-open-lane-conversation').click();
  const childTab = page
    .getByRole('tablist', { name: 'Workspace tabs' })
    .getByRole('tab', { selected: true });
  await expect(childTab).toHaveText(callSign);
  await expect(
    page.getByRole('region', { exact: true, name: callSign }).getByText(CHILD_DONE, {
      exact: true,
    })
  ).toBeVisible();
  expect(modelProvider.refusals()).toEqual([]);
});
