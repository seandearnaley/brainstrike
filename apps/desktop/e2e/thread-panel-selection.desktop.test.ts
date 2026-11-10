import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';

const REPLY = 'SELECTION_REPLY';

/**
 * Whether the document's selection is somewhere the thread tabs do not show:
 * inside a hidden thread panel, or on the element that holds the panels.
 */
function selectionOffScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const anchor = document.getSelection()?.anchorNode;
    if (!anchor) {
      return false;
    }
    const element = anchor instanceof Element ? anchor : anchor.parentElement;
    const inHiddenPanel = Boolean(
      element?.closest('[data-testid^="assistant-thread-panel-"][hidden]')
    );
    const onPanelsContainer =
      anchor instanceof Element &&
      anchor.querySelector(':scope > [data-testid^="assistant-thread-panel-"]') !== null;
    return inHiddenPanel || onPanelsContainer;
  });
}

/**
 * A selection outlives the panel that showed it: a tab switch hides the thread
 * that holds it, and a removed composer hands its caret to the element it was
 * removed from, between the kept-alive panels. Chromium then looks for a place
 * to draw it on every frame the page changes, walking each hidden panel's DOM
 * (a third of the main thread while a reply streamed with nine threads open).
 */
test('a selection does not stay behind in a thread that is hidden or closed', async ({
  electron,
  modelProvider,
}) => {
  // The title request carries no tools; every turn replies at once.
  modelProvider.setScript(({ toolNames }) => ({
    finalText: toolNames.length === 0 ? 'Selection thread' : REPLY,
  }));
  const window = await electron.ensureWindow();
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await ensureAssistantShellVisible(window);
  const strip = window.getByRole('tablist', { name: 'Open assistant threads' });

  const first = await startThread(window, 'Say the first sentence.');
  await expect(first.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  const second = await startThread(window, 'Say the second sentence.');
  await expect(second.getByText(REPLY, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(second.getByRole('button', { exact: true, name: 'Stop' })).toHaveCount(0);

  // The reply's text is selected, then its thread is hidden by a tab switch.
  await second.getByText(REPLY, { exact: true }).selectText();
  expect(await window.evaluate(() => document.getSelection()?.toString())).toBe(REPLY);
  await strip.getByRole('tab').first().click();
  await expect(second).toBeHidden();
  expect(await selectionOffScreen(window)).toBe(false);

  // Closing a tab removes its panel, and with it the composer holding a draft's caret.
  await first.getByRole('textbox', { name: 'Message input' }).fill('An unsent draft');
  await strip.getByRole('tab', { selected: true }).focus();
  await window.keyboard.press('Delete');
  await expect(first).toHaveCount(0);
  expect(await selectionOffScreen(window)).toBe(false);
});
