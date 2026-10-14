import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostThreadTree } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { reloadRenderer } from './utils/electron-helpers.mts';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderRequest, ScriptedToolCall } from './utils/model-provider-shim';
import { seedRoot } from './utils/seed-root';

// The October 14 owner screenshot: a GPT-6 Luna run of sequential reads drew
// one "Read · 1 step" group per model step, and opaque reasoning drew empty
// thinking rows. Every turn here carries Luna's recorded reasoning shape
// (encrypted state, no summary), and every call is its own model step.
const REPLY = 'The siphon tour is complete.';
const FILES = Array.from({ length: 12 }, (_unused, index) => `src/module-${index + 1}.ts`);
const READ = 'brainstrike_readWorkspaceFile';
const STAGES: readonly (readonly ScriptedToolCall[])[] = [
  [{ arguments: { pattern: 'src/**/*.ts' }, name: 'brainstrike_globWorkspace' }],
  [{ arguments: { pattern: 'export const' }, name: 'brainstrike_grepSearch' }],
  ...FILES.map((file) => [{ arguments: { path: file }, name: READ }]),
];
// The step the run is held in, so the live view can be read mid-run.
const HELD_AFTER_RESULTS = 7;
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-e2e-long-tool-run-')));
mkdirSync(path.join(root, 'src'));
for (const [index, file] of FILES.entries()) {
  writeFileSync(path.join(root, file), `export const module${index + 1} = ${index + 1};\n`);
}
// After the app's own teardown, which still reads the bound folder.
test.afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

function toolResults(request: ModelProviderRequest): number {
  const lastUser = request.messages.findLastIndex(
    (item) => typeof item === 'object' && item !== null && Reflect.get(item, 'role') === 'user'
  );
  return request.messages
    .slice(lastUser + 1)
    .filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        Reflect.get(item, 'type') === 'function_call_output'
    ).length;
}

async function expectOneGroupWithoutEmptyThinking(region: Locator): Promise<Locator> {
  const groups = region.getByTestId('assistant-activity-group');
  await expect(groups).toHaveCount(1);
  // A reasoning row only exists for reasoning the user can read.
  await expect(region.getByTestId('local-chain-of-thought')).toHaveCount(0);
  return groups.first();
}

test('a long Luna run of one-call steps reads as one activity group without empty thinking rows', async ({
  electron,
  modelProvider,
  window: page,
}, testInfo) => {
  test.setTimeout(300_000);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await seedRoot(page, root, {
      disableBackgroundIndexing: true,
      reloadReason: 'long-tool-run-root',
      rootId: randomUUID(),
    });
    await configureAssistantProvider(page, {
      apiKey: 'test-key-long-tool-run',
      compositeModelKey: 'openai::gpt-6-luna',
      provider: 'openai',
    });
    modelProvider.setScript((request) => {
      if ((request.requestBody as { stream?: unknown }).stream !== true) {
        return { finalText: 'Siphon tour' };
      }
      // Hosted discovery may defer the workspace tools: load them first when it does.
      const deferred = !request.toolNames.includes(READ);
      const stages = deferred
        ? [
            [
              {
                arguments: {
                  toolNames: ['brainstrike_globWorkspace', 'brainstrike_grepSearch', READ],
                },
                name: 'load_tool',
              },
            ],
            ...STAGES,
          ]
        : STAGES;
      return {
        emptyResponsesReasoning: true,
        finalText: REPLY,
        toolCallStages: stages,
        ...(toolResults(request) === HELD_AFTER_RESULTS ? { beforeToolFinish: held } : {}),
      };
    });

    await ensureAssistantShellVisible(page);
    const region = page.getByRole('region', { exact: true, name: 'Assistant' });
    await region.getByRole('textbox', { name: 'Message input' }).fill('Tour the siphon sources.');
    await region.getByRole('button', { exact: true, name: 'Send' }).click();

    // Live, mid-run: the held step has streamed its opaque reasoning and its call.
    await expect
      .poll(() => modelProvider.transcript().length, { timeout: 90_000 })
      .toBeGreaterThan(HELD_AFTER_RESULTS);
    const live = await expectOneGroupWithoutEmptyThinking(region);
    await expect(live).toHaveAttribute('data-active', 'true');
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('live-long-tool-run.png'),
    });
    release();

    await expect(region.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 90_000 });
    const calls = modelProvider
      .transcript()
      .filter(({ decision }) => decision.startsWith('tool:')).length;
    const settled = await expectOneGroupWithoutEmptyThinking(region);
    await expect(settled).toHaveAttribute('data-state', 'done');
    await expect(settled.getByTestId('assistant-activity-summary')).toContainText(`${calls} steps`);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('settled-long-tool-run.png'),
    });
    const summary = settled.getByTestId('assistant-activity-summary');
    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    const body = settled.getByTestId('assistant-activity-body');
    await expect(body).toBeVisible();
    await expect(body.getByTestId('tool-fallback')).toHaveCount(calls);
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('expanded-long-tool-run.png'),
    });

    // The committed host log alone restores the same single group.
    await reloadRenderer(page, 'long-tool-run-reload');
    await ensureAssistantShellVisible(page);
    const reloaded = page.getByRole('region', { exact: true, name: 'Assistant' });
    await expect(reloaded.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
    const restored = await expectOneGroupWithoutEmptyThinking(reloaded);
    await expect(restored.getByTestId('assistant-activity-summary')).toContainText(
      `${calls} steps`
    );
    expect(modelProvider.refusals()).toEqual([]);
    const tree = testInfo.outputPath('committed-thread-tree.json');
    writeFileSync(
      tree,
      JSON.stringify(await readHostThreadTree(electron.getUserDataDir()), null, 2)
    );
    await testInfo.attach('committed-thread-tree', { contentType: 'application/json', path: tree });
  } finally {
    release();
  }
});
