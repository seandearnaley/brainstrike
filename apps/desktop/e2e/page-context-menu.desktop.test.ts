/**
 * Desktop E2E: right-clicking a reply's selected text offers Copy, and
 * right-clicking the composer offers Cut, Copy, Paste and Select All. The menu
 * is native, so main records each menu it would open instead of showing it.
 */
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';

const REPLY = 'The capital of France is Paris.';

/** Each item as the user reads it: its label, `(disabled)` when greyed, or `---`. */
async function recordContextMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const opened: string[][] = [];
    Object.assign(globalThis, { __pageContextMenus: opened });
    Menu.prototype.popup = function record(this: Electron.Menu): void {
      opened.push(
        this.items.map((item) =>
          item.type === 'separator' ? '---' : `${item.label}${item.enabled ? '' : ' (disabled)'}`
        )
      );
    };
  });
}

function lastContextMenu(app: ElectronApplication): Promise<readonly string[] | null> {
  return app.evaluate(() => {
    const opened = (globalThis as { __pageContextMenus?: readonly string[][] }).__pageContextMenus;
    return opened?.at(-1) ?? null;
  });
}

test('right-click offers Copy over a reply and the edit commands in the composer', async ({
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(90_000);
  const app = electronApp.app;
  await recordContextMenus(app);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
  modelProvider.setScript(() => ({ finalText: REPLY }));
  const conversation = await startThread(page, 'What is the capital of France?');

  const reply = conversation.getByText(REPLY, { exact: true });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await reply.selectText();
  await reply.click({ button: 'right' });
  await expect.poll(() => lastContextMenu(app)).toEqual(['Copy']);

  const input = conversation.getByRole('textbox', { name: 'Message input' });
  await input.fill('a follow-up question');
  await input.selectText();
  await input.click({ button: 'right' });
  // Paste follows the clipboard, which this test does not own.
  await expect
    .poll(async () => (await lastContextMenu(app))?.map((item) => item.replace(' (disabled)', '')))
    .toEqual(['Cut', 'Copy', 'Paste', '---', 'Select All']);
  expect((await lastContextMenu(app))?.slice(0, 2)).toEqual(['Cut', 'Copy']);
});
