import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/**
 * BST-1632: "connected" is a transport fact, and a server can connect while
 * contributing no tools in two healthy ways. One lists zero tools. One
 * advertises no tools capability at all (prompts only). Settings names each
 * from the host snapshot, in a muted tone, and never flashes the amber
 * "tools unavailable" warning on the way there.
 */

const FIXTURE = fileURLToPath(
  import.meta.resolve('@brainstrike/agent/test-fixtures/mcp-stdio-catalog-shape-server.mjs')
);
const EMPTY = 'empty-tools';
const PROMPTS_ONLY = 'prompts-only';

function stdioServer(name: string, shape: string) {
  return {
    args: [FIXTURE],
    command: process.execPath,
    env: { BRAINSTRIKE_STDIO_CATALOG_SHAPE: shape },
    name,
    protocol: 'legacy',
    transport: 'stdio',
  };
}

test('a connected server with no tools says so plainly, without a warning flash', async ({
  window,
}) => {
  test.setTimeout(180_000);
  // Watch the whole document from before the servers are configured, so a
  // transient amber state would be caught even if it lasted one render.
  await window.evaluate(() => {
    const seen = { warning: false };
    (
      globalThis as { __toolsAvailabilityWarningSeen?: typeof seen }
    ).__toolsAvailabilityWarningSeen = seen;
    new MutationObserver(() => {
      if (document.querySelector('[data-tools-availability="tools-unavailable"]')) {
        seen.warning = true;
      }
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
  });

  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/AI Tools/iu, 'ai-tools');
  await window.getByRole('tab', { name: 'MCP Config' }).click();
  await window.getByTestId('mcp-config-editor').fill(
    JSON.stringify({
      servers: [stdioServer(EMPTY, 'empty-tools'), stdioServer(PROMPTS_ONLY, 'prompts-only')],
    })
  );
  await window.getByTestId('mcp-config-save').click();
  await expect(window.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await window.getByRole('tab', { exact: true, name: 'Tools' }).click();

  const empty = window.getByTestId(`mcp-server-row-${EMPTY}`);
  const promptsOnly = window.getByTestId(`mcp-server-row-${PROMPTS_ONLY}`);
  await expect(empty.getByText('connected · no tools', { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(promptsOnly.getByText('connected · offers no tools', { exact: true }))
    .toBeVisible({ timeout: 60_000 })
    .catch(async (error: unknown) => {
      throw new Error(
        `prompts-only row: ${await promptsOnly.innerText().catch(() => '<missing>')}`,
        { cause: error }
      );
    });
  for (const [row, availability] of [
    [empty, 'empty'],
    [promptsOnly, 'unsupported'],
  ] as const) {
    const notice = row.locator(`[data-tools-availability="${availability}"]`);
    await expect(notice).toHaveClass(/text-muted-foreground/u);
    await expect(notice).not.toHaveClass(/text-warning/u);
  }

  expect(
    await window.evaluate(
      () =>
        (globalThis as { __toolsAvailabilityWarningSeen?: { warning: boolean } })
          .__toolsAvailabilityWarningSeen?.warning
    )
  ).toBe(false);
});
