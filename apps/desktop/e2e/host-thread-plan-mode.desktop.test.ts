import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

const WRITE = 'brainstrike_writeWorkspaceFile';
const PLAN = 'brainstrike_submitPlan';
const FINAL = 'Implemented the approved plan.';
// The mock workspace is this real disposable folder, so the edit lands on disk.
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-plan-mode-'));

test.use({ electronEnv: { BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace } });
test.afterAll(() => rmSync(workspace, { force: true, recursive: true }));

/** Plan mode hides edits; approving the plan continues straight into a run that edits. */
test('approving a plan in plan mode continues into a follow-up run that edits', async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await new HomePage(window).openSettings();
  await new SettingsPage(window).openCategory(/Permissions/i, 'permissions');
  await window.getByTestId('permission-policy-edit').selectOption('allow');
  modelProvider.setScript(({ requestBody, toolNames }) => {
    if ((requestBody as { stream?: unknown }).stream !== true || toolNames.length === 0) {
      return { finalText: 'Plan mode check' };
    }
    // Planning (no write tool offered) submits a plan; implementing writes the file.
    return toolNames.includes(WRITE)
      ? {
          finalText: FINAL,
          toolCall: { arguments: { content: 'planned\n', path: 'planned.txt' }, name: WRITE },
        }
      : {
          finalText: 'The plan is ready for review.',
          toolCall: {
            arguments: {
              overview: 'Create planned.txt once approved.',
              steps: [{ title: 'Write planned.txt' }],
              title: 'Write planned.txt',
            },
            name: PLAN,
          },
        };
  });
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  const toggle = panel.getByRole('button', { name: 'Toggle plan mode' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await input.fill('Plan, then write planned.txt.');
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();

  const approve = panel.getByRole('button', { exact: true, name: 'Approve plan' });
  await expect(approve).toBeVisible({ timeout: E2E_TIMEOUTS.messageVisibility });
  // The plan run was offered no edit tool.
  const planning = modelProvider.requests().filter(({ toolNames }) => toolNames.length > 0);
  expect(planning.at(-1)?.toolNames).toContain(PLAN);
  expect(planning.at(-1)?.toolNames).not.toContain(WRITE);
  await approve.click();

  // The follow-up run is the thread's next run, and it edits without another message.
  await expect(panel.getByText('Approved the plan.').first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  await expect(panel.getByText(FINAL).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  expect(await readFile(join(workspace, 'planned.txt'), 'utf8')).toBe('planned\n');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(modelProvider.refusals()).toEqual([]);
});
