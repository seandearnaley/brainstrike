import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import type { ElectronHarness } from './fixtures/electron-harness';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { configureAssistantProvider } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { homeEnvironment } from './utils/node-command';
import { seedRoots } from './utils/seed-root';
import { E2E_TIMEOUTS } from './utils/timeouts';

const CONVENTIONS = 'CLONED_CONVENTIONS_2338';
const LATER_CONVENTIONS = 'LATER_CONVENTIONS_0032';
const SKILL = 'cloned-release-skill';

// ADR-0032: a freshly cloned folder's AGENTS.md and skills steer nothing until
// the person trusts the folder. HOME holds no global skills or instructions.
// A shard's worker can run this file's tests one after another, with these
// hooks around each, so the folder is made before every test and only its
// name is fixed here.
const home = join(tmpdir(), `bs-e2e-workspace-trust-home-${randomUUID()}`);
test.beforeAll(() => {
  mkdirSync(home, { recursive: true });
});
test.afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});
test.use({
  electronEnv: {
    BRAINSTRIKE_OPENROUTER_API_KEY: 'test-api-key-for-e2e-tests',
    ...homeEnvironment(home),
  },
});

/**
 * This test's own folders: two kept in one `projects` folder, as a person keeps
 * their repositories, which a trust ask may offer as a trusted location. They
 * sit in the workspace root the harness makes for the test and removes after
 * its app closes, so no test finds another's folders or loses its own. Only
 * the person can add to them, whatever the machine's umask: a folder its group
 * can write to is never offered as a location (ADR-0032).
 */
function projectFolders(electron: ElectronHarness): {
  readonly later: string;
  readonly projects: string;
  readonly workspace: string;
} {
  const projects = join(electron.getWorkspaceRoot(), 'projects');
  const workspace = join(projects, 'cloned');
  const later = join(projects, 'later');
  mkdirSync(join(workspace, '.brainstrike', 'skills', SKILL), { mode: 0o755, recursive: true });
  mkdirSync(later, { mode: 0o755 });
  writeFileSync(join(later, 'AGENTS.md'), `# Conventions\n${LATER_CONVENTIONS}\n`);
  writeFileSync(join(workspace, 'AGENTS.md'), `# Conventions\n${CONVENTIONS}\n`);
  writeFileSync(
    join(workspace, '.brainstrike', 'skills', SKILL, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Shipped by the cloned repository.\n---\nFollow the clone.`
  );
  return { later, projects, workspace };
}

/** The ask's box that would also trust every folder in the projects folder. */
const parentBox = (projects: string) => ({
  exact: true,
  name: `Also trust every folder in ${projects}`,
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
  electron,
  modelProvider,
  window,
}) => {
  const { projects, workspace } = projectFolders(electron);
  await seedRoots(window, [{ path: workspace, rootId: 'root-trust-cloned' }], {
    reloadReason: 'ADR-0032 cloned folder',
  });
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
  // Trusting its parent too is offered, and left alone unless the person ticks it.
  await expect(ask.getByRole('checkbox', parentBox(projects))).not.toBeChecked();
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
  // Trusting the folder alone made no trusted location.
  await expect(settings).toContainText('No trusted locations.');
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

test('ticking the box trusts every folder in the parent, and removing that location makes the others ask again', async ({
  electron,
  modelProvider,
  window,
}) => {
  const { later, projects, workspace } = projectFolders(electron);
  // Two folders kept in the projects folder are open; a new thread reads both.
  await seedRoots(
    window,
    [
      { path: workspace, rootId: 'root-trust-cloned' },
      { path: later, rootId: 'root-trust-later' },
    ],
    { reloadReason: 'ADR-0032 trusted location' }
  );
  await configureAssistantProvider(window);
  await ensureAssistantShellVisible(window);
  const panel = window.getByRole('region', { exact: true, name: 'Assistant' });
  const chip = panel.getByRole('button', { name: /^Workspace trust:/u });
  await expect(chip).toHaveAccessibleName('Workspace trust: 3 held');

  // One answer, with the box ticked, covers both: the other folder is never asked about.
  await chip.click();
  const ask = window.getByRole('dialog', { exact: true, name: 'Workspace trust' });
  const cloned = ask.getByTestId('workspace-bar-trust-ask-root-trust-cloned');
  await expect(cloned).toContainText(`Trust the files in ${basename(workspace)}?`);
  await cloned.getByRole('checkbox', parentBox(projects)).check();
  await cloned.getByRole('button', { exact: true, name: 'Trust folder' }).click();
  await expect(chip).toHaveCount(0);
  const trusted = await send(window, modelProvider, 'Inside the location');
  expect(trusted).toContain(CONVENTIONS);
  expect(trusted).toContain(LATER_CONVENTIONS);

  // Settings lists the location and says why the other folder is trusted.
  await new HomePage(window).openSettings();
  const settings = await new SettingsPage(window).openCategory(
    /Workspace trust/iu,
    'workspace-trust'
  );
  const laterRow = settings.getByRole('listitem').filter({ hasText: join(projects, 'later') });
  await expect(laterRow).toContainText(
    `Trusted because it is in the trusted location ${projects}.`
  );
  const locations = settings.getByRole('list', { exact: true, name: 'Trusted locations' });
  await expect(locations.getByRole('listitem')).toHaveText([new RegExp(`^${projects}`, 'u')]);

  // Removing it keeps the answer given for the first folder; the other is undecided again.
  await locations.getByRole('button', { exact: true, name: `Remove ${projects}` }).click();
  await expect(settings).toContainText('No trusted locations.');
  await expect(laterRow).toContainText('Not trusted yet');
  await expect(
    settings.getByRole('listitem').filter({ hasText: join(projects, 'cloned') })
  ).toContainText('Trusted');
  await ensureAssistantShellVisible(window);
  await expect(chip).toHaveAccessibleName('Workspace trust: 1 held');
  const removed = await send(window, modelProvider, 'After removing the location');
  expect(removed).toContain(CONVENTIONS);
  expect(removed).not.toContain(LATER_CONVENTIONS);
  expect(modelProvider.refusals()).toEqual([]);
});
