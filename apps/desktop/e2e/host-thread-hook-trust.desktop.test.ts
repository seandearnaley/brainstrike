import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_CALL_BLOCKED_MESSAGE } from '@brainstrike/assistant-contract/tool-approval';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { seedHostThreads } from './utils/seed-threads';
import { E2E_TIMEOUTS } from './utils/timeouts';

const REASON = 'Workspace reads are disabled by a project hook';
const LEGACY_TITLE = 'Deleted host conversation';

// A real workspace root whose project hooks file blocks workspace reads. The
// host runs it only at a hash it trusts; HOME holds no global hooks.
const home = mkdtempSync(join(tmpdir(), 'bs-e2e-hook-trust-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-hook-trust-root-'));
writeFileSync(join(workspace, 'notes.txt'), 'trust notes\n');
mkdirSync(join(workspace, '.brainstrike'));
writeFileSync(
  join(workspace, '.brainstrike', 'hooks.json'),
  JSON.stringify({
    PreToolUse: [
      {
        command: `echo '{"decision":"block","reason":"${REASON}"}'; exit 2`,
        // Host runs name the tool `brainstrike.readWorkspaceFile`; legacy runs omit the prefix.
        matcher: { tool_name: 'readWorkspaceFile' },
        type: 'command',
      },
    ],
  })
);

// The legacy server reads the OpenRouter key Main loads from the environment:
// the suite's shared fake key, sent only to the loopback provider boundary.
test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'test-api-key-for-e2e-tests',
    HOME: home,
  },
});
test.afterAll(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(workspace, { force: true, recursive: true });
});

/** Each turn reads notes.txt once, by whichever name the run offers the read, then answers. */
function scriptRead(modelProvider: ModelProviderShim, finalText: string): void {
  modelProvider.setScript(({ requestBody, toolNames }) => {
    const read = toolNames.find((name) => name.endsWith('readWorkspaceFile'));
    return (requestBody as { stream?: unknown }).stream === true && read
      ? { finalText, toolCall: { arguments: { path: 'notes.txt' }, name: read } }
      : { finalText: 'Hook trust check' };
  });
}

async function send(page: Page, prompt: string, finalText: string): Promise<void> {
  await ensureAssistantShellVisible(page);
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(prompt);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(finalText).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
}

/** The model's last follow-up request after a tool call: what it read as the call's result. */
function lastFollowUp(modelProvider: ModelProviderShim): string {
  const followUp = modelProvider
    .requests()
    .filter(({ toolNames }) => toolNames.length > 0)
    .at(-1);
  return JSON.stringify(followUp?.messages);
}

async function hooksSettings(page: Page) {
  await new HomePage(page).openSettings();
  return await new SettingsPage(page).openCategory(/Hooks/i, 'hooks');
}

test('a project hook runs on a host thread only after it is approved in Settings › Hooks', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);

  // Untrusted: the project file adds no hook, so the read runs, and the run
  // names the file it skipped with its remedy at default detail.
  scriptRead(modelProvider, 'The first read finished.');
  await send(window, 'Read notes.txt', 'The first read finished.');
  expect(lastFollowUp(modelProvider)).toContain('trust notes');
  expect(lastFollowUp(modelProvider)).not.toContain(REASON);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const skipped = panel.getByText('Project hooks not trusted', { exact: true });
  await expect(skipped).toHaveCount(1);
  await expect(
    panel.getByText('/.brainstrike/hooks.json: not trusted — review it in Settings > Hooks')
  ).toBeVisible();

  // Settings shows the root untrusted until it is approved through the host.
  const hooks = await hooksSettings(window);
  await expect(hooks.getByText('Untrusted', { exact: true })).toBeVisible();
  await hooks.getByRole('button', { exact: true, name: 'Approve' }).click();
  await expect(hooks.getByText('Trusted', { exact: true })).toBeVisible();
  await expect(hooks.getByRole('button', { exact: true, name: 'Revoke' })).toBeVisible();

  // Trusted: the project PreToolUse hook blocks the next read with its reason.
  scriptRead(modelProvider, 'The second read was blocked.');
  await send(window, 'Read notes.txt again', 'The second read was blocked.');
  expect(lastFollowUp(modelProvider)).toContain(REASON);
  // Trusted, the run skips nothing: only the first turn's notice remains.
  await expect(skipped).toHaveCount(1);
  await panel.getByRole('button', { exact: true, name: 'Expand activity' }).last().click();
  const card = panel.getByTestId('tool-fallback').last();
  await card.getByRole('button', { expanded: false }).click();
  await expect(card.getByText(TOOL_CALL_BLOCKED_MESSAGE)).toBeVisible();
  expect(modelProvider.refusals()).toEqual([]);
});

test('a retired thread cannot start the removed execution path', async ({
  modelProvider,
  window: page,
}) => {
  test.setTimeout(180_000);
  await ensureMockWorkspaceOpen(page);
  await configureAssistantProvider(page);

  // Approved once in Settings › Hooks, through the host.
  const hooks = await hooksSettings(page);
  await hooks.getByRole('button', { exact: true, name: 'Approve' }).click();
  await expect(hooks.getByText('Trusted', { exact: true })).toBeVisible();

  // Deleted host conversations are never advertised as usable host conversations.
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  const [retired] = await seedHostThreads(userData, [{ folder: null, title: LEGACY_TITLE }]);
  if (!retired) {
    throw new Error('Host thread fixture not created');
  }
  await withAppHost(userData, (client) => client.request('thread/delete', { threadId: retired }));
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'hook-trust-retired-thread');
  await ensureAssistantShellVisible(page);
  const showThreads = page.getByTestId('show-threads-panel');
  if (await showThreads.isVisible().catch(() => false)) {
    await showThreads.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible();
  await expect(page.getByTestId('thread-row').filter({ hasText: LEGACY_TITLE })).toHaveCount(0);
  scriptRead(modelProvider, 'The current conversation still works.');
  await send(page, 'Read notes.txt', 'The current conversation still works.');
  expect(lastFollowUp(modelProvider)).toContain(REASON);
  expect(modelProvider.refusals()).toEqual([]);
});
