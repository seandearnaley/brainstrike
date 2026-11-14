/**
 * ADR-0032, ADR-0034 decision 6: a thread that works in a worktree is asked to
 * trust the repository, once, and Settings shows the worktree under its
 * repository's answer. Real git and the real worktree ledger decide whose
 * worktree the folder is.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { setupAssistantMock } from './utils/assistant-mock';
import { chooseThreadFolder } from './utils/choose-thread-folder';
import { createAndUseWorktree } from './utils/create-worktree';
import { createTempDirTracker, freshRepo, git } from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { homeEnvironment } from './utils/node-command';
import { seedRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'trust-worktree-root-00000000-0000-4000-8000-000000002340';
// HOME holds no global skills or instructions.
const home = mkdtempSync(path.join(tmpdir(), 'bs-e2e-trust-worktree-home-'));

test.use({ electronEnv: { ...homeEnvironment(home) } });

test.beforeAll(() => {
  // The ledger keeps a worktree by its real path, so the managed directory is given by one.
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = realpathSync(
    tempDirs.track(mkdtempSync(path.join(tmpdir(), 'bs-e2e-trust-worktrees-')))
  );
});
test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
  rmSync(home, { force: true, recursive: true });
});

test('a thread in a worktree is asked to trust its repository once, and Settings shows one answer', async ({
  window,
}) => {
  test.setTimeout(120_000);
  // The instructions file is committed, so every checkout of the repository holds it.
  const repository = freshRepo({ label: 'repo', prefix: 'bs-e2e-trust-', tracker: tempDirs });
  writeFileSync(path.join(repository, 'AGENTS.md'), '# Conventions\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'add conventions']);
  const repositoryName = path.basename(repository);
  await seedRoot(window, repository, { reloadReason: 'trust-worktree-seed-root', rootId: ROOT_ID });
  await setupAssistantMock(window);
  await ensureAssistantShellVisible(window);
  await chooseThreadFolder(window, repositoryName);
  const chip = window.getByRole('button', { name: /^Workspace trust:/u });
  await expect(chip).toHaveAccessibleName('Workspace trust: 1 held');

  // The thread moves into a new worktree of the repository, which stays open beside it.
  const { name: worktreeName } = await createAndUseWorktree(window);

  // One question, for the repository: the worktree is named as what the answer covers.
  await expect(chip).toBeVisible();
  await chip.click();
  const ask = window.getByRole('dialog', { exact: true, name: 'Workspace trust' });
  await expect(ask).toContainText(`Trust the files in ${repositoryName}?`);
  await expect(ask).toContainText('Your answer covers this repository and its worktrees.');
  await expect(ask).toContainText(`${worktreeName}: AGENTS.md`);
  await expect(ask.getByRole('button', { exact: true, name: 'Trust folder' })).toHaveCount(1);
  await ask.getByRole('button', { exact: true, name: 'Trust folder' }).click();
  await expect(chip).toHaveCount(0);

  // Settings › Workspace trust: one row, the repository's, with the worktree under it.
  await new HomePage(window).openSettings();
  const settings = await new SettingsPage(window).openCategory(
    /Workspace trust/iu,
    'workspace-trust'
  );
  await expect(settings.getByRole('button', { name: /^(Trust|Restrict)$/u })).toHaveCount(1);
  const row = settings.getByTestId(`workspace-trust-root-${ROOT_ID}`);
  await expect(row).toContainText('Trusted');
  await expect(row).toContainText('Its worktrees share this answer');
  await expect(row).toContainText(`${worktreeName} holds AGENTS.md.`);
});
