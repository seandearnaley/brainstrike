import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider, enableAssistantCatalogModel } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startModelProviderShim } from './utils/model-provider-shim';

// Only the external provider is simulated: discovery, stream replay, native
// file reads, durable history, and follow-up admission use the real host.
test('reload discovers a live root without a saved cursor and dispatches Next Up once', async ({
  electron,
}, testInfo) => {
  await assertLiveReload(electron, testInfo, false);
});

test('reload restores an approval continuation and dispatches Next Up once', async ({
  electron,
}, testInfo) => {
  await assertLiveReload(electron, testInfo, true);
});

const ROOT_PROMPT = 'Read evidence.txt for the reload regression.';

function lastUserMessage(messages: readonly unknown[]): unknown {
  return messages
    .filter(
      (message) =>
        message && typeof message === 'object' && 'role' in message && message.role === 'user'
    )
    .at(-1);
}

async function assertLiveReload(
  electron: ElectronHarness,
  testInfo: TestInfo,
  approval: boolean
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-root-reload-'));
  await writeFile(path.join(workspace, 'evidence.txt'), 'RELOAD_READ_EVIDENCE');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const actionEntered = Promise.withResolvers<void>();
  const provider = await startModelProviderShim(({ messages, toolNames }) => {
    if (toolNames.length === 0) {
      return { finalText: 'Reload regression' };
    }
    if (JSON.stringify(lastUserMessage(messages)).includes('RELOAD_NEXT_UP')) {
      return { finalText: 'RELOAD_NEXT_UP_COMPLETE' };
    }
    entered.resolve();
    if (JSON.stringify(messages).includes('RELOAD_READ_EVIDENCE')) {
      actionEntered.resolve();
    }
    return {
      ...(approval ? { beforeFinalText: release.promise } : { beforeToolFinish: release.promise }),
      finalText: 'RELOAD_ROOT_COMPLETE',
      toolCall: { arguments: { path: 'evidence.txt' }, name: 'brainstrike_readWorkspaceFile' },
    };
  });
  const previous = {
    key: process.env['BRAINSTRIKE_OPENROUTER_API_KEY'],
    root: process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'],
    url: process.env['OPENROUTER_BASE_URL'],
  };
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = workspace;
  process.env['OPENROUTER_BASE_URL'] = provider.baseUrl;
  process.env['BRAINSTRIKE_OPENROUTER_API_KEY'] = 'isolated-reload-provider-key';
  try {
    const window = await electron.ensureWindow();
    // Provider turns at the real external boundary: the root's own turns, and
    // the queued follow-up's, told apart by the latest user message each carries.
    const turnsFor = (prompt: string) =>
      provider
        .requests()
        .filter(
          ({ messages, toolNames }) =>
            toolNames.length > 0 && JSON.stringify(lastUserMessage(messages)).includes(prompt)
        );
    const rootTurns = () => turnsFor(ROOT_PROMPT);
    const nextUpTurns = () => turnsFor('RELOAD_NEXT_UP');
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
    await new HomePage(window).openSettings();
    await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
    await window
      .getByRole('combobox', { exact: true, name: 'Read permission' })
      .selectOption(approval ? 'ask' : 'allow');
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    const input = panel.getByRole('textbox', { name: 'Message input' });
    await input.fill(ROOT_PROMPT);
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await entered.promise;
    if (approval) {
      await panel
        .getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
        .click();
      await actionEntered.promise;
    }
    // One turn calls the tool; an approved read adds the turn that carries its result.
    const admittedTurns = approval ? 2 : 1;
    await expect.poll(() => rootTurns().length).toBe(admittedTurns);
    if (approval) {
      const graph = await window.evaluate(async () => {
        const query = (
          window as unknown as {
            electronAPI: { db: { query: (sql: string) => Promise<unknown> } };
          }
        ).electronAPI.db.query;
        return query(`SELECT m.id, m.role, m.content, p.parent_id
          FROM mastra_messages m
          LEFT JOIN brainstrike_assistant_message_parents p ON p.message_id = m.id
          ORDER BY m."createdAt"`);
      });
      await testInfo.attach('pre-reload-history', {
        body: JSON.stringify(graph, null, 2),
        contentType: 'application/json',
      });
    }
    await window.evaluate(() => window.sessionStorage.clear());
    await window.reload();
    await ensureAssistantShellVisible(window);
    // Reinstall the fixture's renderer-only provider availability override.
    await configureAssistantProvider(window, {
      compositeModelKey: 'openrouter::openai/gpt-5.4',
      provider: 'openrouter',
    });
    await enableAssistantCatalogModel(window, 'openrouter::openai/gpt-5.4');
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toBeVisible();
    // Reload reattaches to the live root; it never re-executes it.
    expect(rootTurns()).toHaveLength(admittedTurns);
    await input.fill('RELOAD_NEXT_UP');
    await panel
      .getByRole('button', { exact: true, name: 'Queue message to send after this run' })
      .click();
    expect(rootTurns()).toHaveLength(admittedTurns);
    expect(nextUpTurns()).toHaveLength(0);
    release.resolve();
    await expect(panel.getByText('RELOAD_ROOT_COMPLETE', { exact: true })).toBeVisible();
    await expect(panel.getByText('RELOAD_NEXT_UP_COMPLETE', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);
    // The root ran once (tool call, then its result) and Next Up dispatched once,
    // carrying the root's history.
    expect(rootTurns()).toHaveLength(2);
    expect(nextUpTurns()).toHaveLength(1);
    expect(JSON.stringify(nextUpTurns()[0]?.messages)).toContain('RELOAD_READ_EVIDENCE');
    await expect(panel.getByText(/awaiting stream reattachment/)).toHaveCount(0);
    await window.screenshot({ path: testInfo.outputPath('recovered-root-next-up.png') });
  } finally {
    release.resolve();
    await testInfo.attach('provider-transcript', {
      body: JSON.stringify(provider.transcript(), null, 2),
      contentType: 'application/json',
    });
    try {
      await electron.dispose();
    } finally {
      await provider.close();
      for (const [key, value] of [
        ['OPENROUTER_BASE_URL', previous.url],
        ['BRAINSTRIKE_OPENROUTER_API_KEY', previous.key],
        ['BRAINSTRIKE_E2E_REAL_ROOT_PATH', previous.root],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(workspace, { force: true, recursive: true });
    }
  }
}
