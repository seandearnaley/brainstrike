import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const FINAL = 'The verdict run finished.';

// A global Stop hook labels every host run; the user's own verdict outranks it.
const home = mkdtempSync(join(tmpdir(), 'bs-e2e-run-verdict-home-'));
// Global hooks run in the main root, which must exist on disk.
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-run-verdict-root-'));
mkdirSync(join(home, '.brainstrike'));
writeFileSync(
  join(home, '.brainstrike', 'hooks.json'),
  JSON.stringify({
    Stop: [
      {
        command: `printf '%s\\n' '${JSON.stringify({ brainstrikeRunVerdict: { detail: 'Graded', verdict: 'succeeded' } })}'`,
        type: 'command',
      },
    ],
  })
);

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace, HOME: home } });
test.afterAll(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(workspace, { force: true, recursive: true });
});

function assistant(page: Page) {
  return page.getByRole('region', { exact: true, name: 'Assistant' });
}

/** The finished run's verdict footer, on its final message. */
function footer(page: Page) {
  return assistant(page).getByTestId('run-verdict-footer').last();
}

test('a host run shows its hook verdict, and the user’s verdict outranks it across a reload', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript({ finalText: FINAL });
  await ensureAssistantShellVisible(window);
  const input = assistant(window).getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Finish one run');
  await assistant(window).getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(assistant(window).getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });

  // The Stop hook's committed verdict is visible; no user verdict yet.
  await expect(footer(window).getByTestId('run-verdict-derived')).toHaveText(
    'Hook verdict: succeeded'
  );
  const didNotWork = footer(window).getByRole('button', { name: "This didn't work" });
  await expect(didNotWork).toHaveAttribute('aria-pressed', 'false');

  // The user's verdict is committed through the host and outranks the hook's.
  await didNotWork.click();
  await expect(didNotWork).toHaveAttribute('aria-pressed', 'true');
  await expect(footer(window).getByTestId('run-verdict-derived')).toHaveCount(0);

  // After a reload the thread reads its committed verdicts back.
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(window, 'host-thread-run-verdict');
  await ensureAssistantShellVisible(window);
  await expect(assistant(window).getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(footer(window).getByRole('button', { name: "This didn't work" })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(footer(window).getByRole('button', { name: 'This worked' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await expect(footer(window).getByTestId('run-verdict-derived')).toHaveCount(0);
  expect(modelProvider.refusals()).toEqual([]);
});
