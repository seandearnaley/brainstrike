// The user flow that starts a real MCP task against the pending-input fixture
// (`mcp-pending-input-fixture.ts`): configure the server, then ask the scripted
// model to call its task tool and approve the call. Shared by the dev-mode
// cancellation spec and the packaged restart spec.
import { expect, type Page } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import { SettingsPage } from '../page-objects/settings-page';

const PENDING_INPUT_SERVER_ID = 'pending-input';
export const PENDING_INPUT_TOOL_NAME = 'pending-input_start_task';

/** Configure the fixture as a 2026-07-28 streamable-http server, with MCP calls set to ask. */
export async function configurePendingInputServer(page: Page, url: string): Promise<void> {
  await new HomePage(page).openSettings();
  const settings = new SettingsPage(page);
  await settings.openCategory(/AI Tools/iu, 'ai-tools');
  await page.getByRole('tab', { name: 'MCP Config' }).click();
  const editor = page.getByTestId('mcp-config-editor');
  await expect(editor).toBeVisible();
  await editor.fill(
    JSON.stringify({
      servers: [
        {
          name: PENDING_INPUT_SERVER_ID,
          protocol: '2026-07-28',
          transport: 'streamable-http',
          url,
        },
      ],
    })
  );
  await page.getByTestId('mcp-config-save').click();
  await expect(page.getByTestId('mcp-config-status')).toHaveText('MCP config saved.');
  await page.getByRole('tab', { exact: true, name: 'Tools' }).click();
  const row = page.getByTestId(`mcp-server-row-${PENDING_INPUT_SERVER_ID}`);
  await expect(row).toContainText(/Connected/iu, { timeout: 60_000 });
  await expect(row).toContainText('2026-07-28');
  await settings.openCategory(/Permissions/iu, 'permissions');
  const permission = page.getByRole('combobox', { name: 'MCP permission' });
  await permission.selectOption('ask');
  await expect(permission).toHaveValue('ask');
  await page.keyboard.press('Escape');
}

/** Send `prompt`, approve the task tool call, and wait for the task's input request. */
export async function beginPendingInputTask(page: Page, prompt: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(prompt);
  await page.getByRole('button', { exact: true, name: 'Send' }).click();
  await page
    .getByRole('button', { exact: true, name: `Approve ${PENDING_INPUT_SERVER_ID}.start_task` })
    .click({ timeout: 45_000 });
  const dialog = page.getByTestId('mcp-elicitation-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText('Approve the reference task?');
  await expect(dialog).toContainText(`Configured server "${PENDING_INPUT_SERVER_ID}"`);
  await expect(dialog.getByRole('button', { name: /^Decline/u })).toBeFocused();
}
