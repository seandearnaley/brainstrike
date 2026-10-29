// An MCP tool's guard is an inactivity budget (BST-1779), in the real app. The
// guard window is shrunk to 3 s (`BRAINSTRIKE_TOOL_TIMEOUT_MS`, the resilience
// default the host binds MCP tools with) so the proof is quick. A stdio server
// that reports progress every 0.5 s and answers after 9 s, three windows,
// succeeds; under a flat guard it was cancelled at 3 s. The same server kept
// silent is cancelled at the window, and the model reads that it went silent.
// A server configured with its own `toolTimeoutMs` gives a silent tool that
// window instead; a value past the ten-minute ceiling is refused where it is typed.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
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

/** The fixture server's config entry; `fields` adds server settings such as `toolTimeoutMs`. */
type FixtureServer = Readonly<Record<string, unknown>> & { readonly name: string };

function fixtureServer(
  serverId: string,
  env: Readonly<Record<string, string>>,
  fields: Readonly<Record<string, unknown>> = {}
): FixtureServer {
  return {
    args: [FIXTURE],
    command: process.execPath,
    env,
    name: serverId,
    protocol: 'legacy',
    transport: 'stdio',
    ...fields,
  };
}

async function openMcpConfig(window: Page): Promise<void> {
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/AI Tools/iu, 'ai-tools');
  await window.getByRole('tab', { name: 'MCP Config' }).click();
}

async function configureServer(window: Page, server: FixtureServer): Promise<void> {
  await openMcpConfig(window);
  await window.getByTestId('mcp-config-editor').fill(JSON.stringify({ servers: [server] }));
  await window.getByTestId('mcp-config-save').click();
  await expect(window.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await window.getByRole('tab', { exact: true, name: 'Tools' }).click();
  const row = window.getByTestId(`mcp-server-row-${server.name}`);
  await expect(row).toContainText(/connected/iu, { timeout: 60_000 });
  if (typeof server['toolTimeoutMs'] === 'number') {
    // The connected generation states the window it runs under.
    await row.getByText('Connection details').click();
    await expect(row).toContainText(`tool timeout ${server['toolTimeoutMs'] / 1000} s`);
  }
  await window.keyboard.press('Escape');
}

/** Configure the slow server, have the model call its tool, and return what the tool told it. */
async function runSlowTool(
  harness: ElectronHarness,
  window: Page,
  modelProvider: ModelProviderShim,
  env: Readonly<Record<string, string>>,
  fields: Readonly<Record<string, unknown>> = {}
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bst-1779-'));
  harness.removeAfterClose(directory);
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  const serverId = 'slow-progress';
  await configureServer(
    window,
    fixtureServer(
      serverId,
      {
        BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '9000',
        BRAINSTRIKE_STDIO_PROGRESS_INTERVAL_MS: '500',
        BRAINSTRIKE_STDIO_PROGRESS_STATE_FILE: join(directory, 'state.json'),
        ...env,
      },
      fields
    )
  );
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
}

test('a tool that keeps reporting progress runs past its window and finishes (BST-1779)', async ({
  electronHarness,
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  expect(await runSlowTool(electronHarness, window, modelProvider, {})).toContain('finished');
});

test('a silent tool is cancelled at its window, and the model reads why (BST-1779)', async ({
  electronHarness,
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  expect(
    await runSlowTool(electronHarness, window, modelProvider, {
      BRAINSTRIKE_STDIO_PROGRESS_SILENT: '1',
    })
  ).toContain('reported no progress for 3s');
});

test("a silent tool runs past the host's window on a server configured with a longer one (BST-1779)", async ({
  electronHarness,
  modelProvider,
  window,
}) => {
  test.setTimeout(240_000);
  // Silent for 5 s: past the host's 3 s window, inside the server's 8 s.
  expect(
    await runSlowTool(
      electronHarness,
      window,
      modelProvider,
      {
        BRAINSTRIKE_STDIO_PROGRESS_FINISH_AFTER_MS: '5000',
        BRAINSTRIKE_STDIO_PROGRESS_SILENT: '1',
      },
      { toolTimeoutMs: 8000 }
    )
  ).toContain('finished');
});

test('a server tool window past the ten-minute ceiling is refused where it is typed (BST-1779)', async ({
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await openMcpConfig(window);
  await window
    .getByTestId('mcp-config-editor')
    .fill(JSON.stringify({ servers: [fixtureServer('too-slow', {}, { toolTimeoutMs: 600_001 })] }));
  await window.getByTestId('mcp-config-save').click();
  await expect(window.getByTestId('mcp-config-error')).toContainText(
    'servers.0.toolTimeoutMs: must be a whole number of milliseconds from 1000 (1 s) to 600000 (10 min)'
  );
  await expect(window.getByTestId('mcp-config-status')).toHaveCount(0);
});
