// An MCP tool's guard is an inactivity budget (BST-1779), in the real app. The
// guard window is shrunk to 3 s (`BRAINSTRIKE_TOOL_TIMEOUT_MS`, the resilience
// default the host binds MCP tools with) so the proof is quick. A stdio server
// that reports progress every 0.5 s and answers after 9 s, three windows,
// succeeds; under a flat guard it was cancelled at 3 s. The same server kept
// silent is cancelled at the window, and the model reads that it went silent.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';

test.use({ electronEnv: { BRAINSTRIKE_TOOL_TIMEOUT_MS: '3000' } });

const FIXTURE = fileURLToPath(
  import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-progress-cancellation-server.mjs')
);

function streaming(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'stream' in value && value.stream === true;
}

async function configureServer(
  window: Page,
  serverId: string,
  env: Record<string, string>
): Promise<void> {
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/AI Tools/i, 'ai-tools');
  await window.getByRole('tab', { name: 'MCP Config' }).click();
  await window.getByTestId('mcp-config-editor').fill(
    JSON.stringify({
      servers: [
        {
          args: [FIXTURE],
          command: process.execPath,
          env,
          name: serverId,
          protocol: 'legacy',
          transport: 'stdio',
        },
      ],
    })
  );
  await window.getByTestId('mcp-config-save').click();
  await expect(window.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await window.getByRole('tab', { exact: true, name: 'Tools' }).click();
  await expect(window.getByTestId(`mcp-server-row-${serverId}`)).toContainText(/connected/i, {
    timeout: 60_000,
  });
  await window.keyboard.press('Escape');
}

/** Configure the slow server, have the model call its tool, and return what the tool told it. */
async function runSlowTool(
  window: Page,
  modelProvider: ModelProviderShim,
  env: Readonly<Record<string, string>>
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bst-1779-'));
  try {
    await ensureMockWorkspaceOpen(window);
    await configureAssistantProvider(window);
    const serverId = 'slow-progress';
    await configureServer(window, serverId, {
      BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '9000',
      BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '500',
      BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: join(directory, 'state.json'),
      ...env,
    });
    const finalText = 'Inactivity budget checked.';
    modelProvider.setScript(({ requestBody }) =>
      streaming(requestBody)
        ? {
            deferredTool: true,
            finalText,
            toolCall: { arguments: {}, name: `${serverId}_progress_forever` },
          }
        : { finalText: 'Inactivity budget' }
    );
    await ensureAssistantShellVisible(window);
    const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
    await panel.getByRole('textbox', { name: 'Message input' }).fill('Run the slow tool.');
    await panel.getByRole('button', { exact: true, name: 'Send' }).click();
    await expect(panel.getByText(finalText, { exact: true })).toBeVisible({ timeout: 90_000 });
    // What the tool returned, as the model received it.
    return JSON.stringify(modelProvider.requests().flatMap(({ messages }) => messages));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('a tool that keeps reporting progress runs past its window and finishes (BST-1779)', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  expect(await runSlowTool(window, modelProvider, {})).toContain('finished');
});

test('a silent tool is cancelled at its window, and the model reads why (BST-1779)', async ({
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  expect(
    await runSlowTool(window, modelProvider, { BRAINSTRIKE_STDIO_PROGRESS_SILENT: '1' })
  ).toContain('reported no progress for 3s');
});
