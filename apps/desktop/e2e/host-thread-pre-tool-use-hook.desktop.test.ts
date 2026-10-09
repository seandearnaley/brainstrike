import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_CALL_BLOCKED_MESSAGE } from '@brainstrike/assistant-contract/tool-approval';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const REASON = 'Workspace reads are disabled by a global hook';

// The global hooks file is `$HOME/.brainstrike/hooks.json`; this spec's app
// (Main and its host) gets a private HOME holding one PreToolUse hook.
const home = mkdtempSync(join(tmpdir(), 'bs-e2e-host-hooks-home-'));
// A real workspace root: global hooks run in the main root, so it must exist on disk.
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-host-hooks-root-'));
mkdirSync(join(home, '.brainstrike'));
writeFileSync(
  join(home, '.brainstrike', 'hooks.json'),
  JSON.stringify({
    PreToolUse: [
      {
        command: `echo '{"decision":"block","reason":"${REASON}"}'; exit 2`,
        matcher: { tool_name: '^brainstrike\\.readWorkspaceFile$' },
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

/** A global PreToolUse hook blocks an allowed tool on a host thread, and its reason reaches the model. */
test('a global PreToolUse hook blocks a host tool call with its reason', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  modelProvider.setScript(({ requestBody, toolNames }) =>
    (requestBody as { stream?: unknown }).stream === true && toolNames.length > 0
      ? {
          finalText: 'The read was blocked.',
          toolCall: { arguments: { path: 'notes.txt' }, name: 'brainstrike_readWorkspaceFile' },
        }
      : { finalText: 'Hook check' }
  );
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill('Read notes.txt');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  await expect(panel.getByText('The read was blocked.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(
    panel.getByRole('button', { exact: true, name: 'Approve brainstrike.readWorkspaceFile' })
  ).toHaveCount(0);
  // The blocked call settles as blocked, with the hook's reason in its result.
  await panel.getByRole('button', { exact: true, name: 'Expand activity' }).click();
  const card = panel.getByTestId('tool-fallback');
  await card.getByRole('button', { expanded: false }).click();
  await expect(card.getByText(TOOL_CALL_BLOCKED_MESSAGE)).toBeVisible();
  await expect(card.getByText(REASON)).toBeVisible();
  // The model's follow-up request carries the hook's reason as the call's result.
  const followUp = modelProvider
    .requests()
    .filter(({ toolNames }) => toolNames.length > 0)
    .at(-1);
  expect(JSON.stringify(followUp?.messages)).toContain(REASON);
  expect(modelProvider.refusals()).toEqual([]);
});
