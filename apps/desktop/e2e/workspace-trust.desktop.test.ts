import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { homeEnvironment } from './utils/node-command';
import { E2E_TIMEOUTS } from './utils/timeouts';

const CONVENTIONS = 'CLONED_CONVENTIONS_2338';
const SKILL = 'cloned-release-skill';

// ADR-0032: a freshly cloned folder's AGENTS.md and skills steer nothing until
// the person trusts the folder. HOME holds no global skills or instructions.
const home = mkdtempSync(join(tmpdir(), 'bs-e2e-workspace-trust-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'bs-e2e-workspace-trust-root-'));
writeFileSync(join(workspace, 'AGENTS.md'), `# Conventions\n${CONVENTIONS}\n`);
mkdirSync(join(workspace, '.brainstrike', 'skills', SKILL), { recursive: true });
writeFileSync(
  join(workspace, '.brainstrike', 'skills', SKILL, 'SKILL.md'),
  `---\nname: ${SKILL}\ndescription: Shipped by the cloned repository.\n---\nFollow the clone.`
);

test.use({
  electronEnv: {
    BRAINSTRIKE_E2E_REAL_ROOT_PATH: workspace,
    BRAINSTRIKE_OPENROUTER_API_KEY: 'test-api-key-for-e2e-tests',
    ...homeEnvironment(home),
  },
});
test.afterAll(() => {
  rmSync(home, { force: true, recursive: true });
  rmSync(workspace, { force: true, recursive: true });
});

/** Sends `prompt` and returns what the run showed the model: its instructions and messages. */
async function send(page: Page, modelProvider: ModelProviderShim, prompt: string): Promise<string> {
  const reply = `${prompt} answered`;
  modelProvider.setScript({ finalText: reply });
  const panel = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = panel.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible({ timeout: E2E_TIMEOUTS.inputVisibility });
  await input.fill(prompt);
  await panel.getByRole('button', { exact: true, name: 'Send' }).click();
  await expect(panel.getByText(reply).first()).toBeVisible({
    timeout: E2E_TIMEOUTS.messageVisibility,
  });
  // The run's own request: the one that carries its tools, not the title request.
  const run = modelProvider
    .requests()
    .filter(({ toolNames }) => toolNames.length > 0)
    .at(-1);
  return JSON.stringify(run?.requestBody);
}

test("a cloned folder's AGENTS.md and skills load only after the person trusts it", async ({
  modelProvider,
  window,
}) => {
  await ensureMockWorkspaceOpen(window);
  await configureAssistantProvider(window);
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });

  // The composer's chip counts what the folder holds back; nothing waits on it.
  const chip = panel.getByRole('button', { name: /^Workspace trust:/u });
  await expect(chip).toHaveAccessibleName('Workspace trust: 2 held');
  const before = await send(window, modelProvider, 'Before trust');
  expect(before).not.toContain(CONVENTIONS);
  expect(before).not.toContain(SKILL);

  // Opening it asks, naming what trusting the folder would load.
  await chip.click();
  const ask = window.getByRole('dialog', { exact: true, name: 'Workspace trust' });
  await expect(ask).toContainText(`Trust the files in ${basename(workspace)}?`);
  await expect(ask).toContainText('AGENTS.md and 1 skill');
  await ask.getByRole('button', { exact: true, name: 'Trust folder' }).click();
  await expect(chip).toHaveCount(0);
  const after = await send(window, modelProvider, 'After trust');
  expect(after).toContain(CONVENTIONS);
  expect(after).toContain(SKILL);

  // Settings › Workspace Trust keeps the answer and changes it.
  await new HomePage(window).openSettings();
  const settings = await new SettingsPage(window).openCategory(
    /Workspace trust/iu,
    'workspace-trust'
  );
  const row = settings.getByRole('listitem').filter({ hasText: basename(workspace) });
  await expect(row).toContainText('Trusted');
  await row.getByRole('button', { exact: true, name: 'Restrict' }).click();
  await expect(row).toContainText('Restricted');
  await ensureAssistantShellVisible(window);
  // Restricted is an answer too: the composer does not ask again.
  await expect(chip).toHaveCount(0);
  const restricted = await send(window, modelProvider, 'After restricting');
  expect(restricted).not.toContain(CONVENTIONS);
  expect(restricted).not.toContain(SKILL);
  expect(modelProvider.refusals()).toEqual([]);
});
