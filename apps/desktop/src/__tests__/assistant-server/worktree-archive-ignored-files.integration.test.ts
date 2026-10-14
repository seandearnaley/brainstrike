// @vitest-environment node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectWorktreeSafety } from '../../assistant-server/worktree-archive';
import { execFileGitRunner } from '../../git-ipc-handlers';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

describe('WorktreeService ignored-file archive confirmation (real git + real SQLite)', () => {
  let db: StateStore;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-state-'));
    repo = workspace.freshRepo('ignored-archive-repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('requires a current ignored-path confirmation before archive deletes ignored files', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.env\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore local env']);
    const service = buildTestService({ db, managedDirectory, repo });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ignored-confirmation' },
      createdBy: 'user',
      name: 'ignored-confirmation',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    const { worktree } = created.value;
    writeFileSync(path.join(worktree.path, '.env'), 'SECRET=test\n');

    const preview = await service.inspectArchive({ worktreeId: worktree.id });
    expect(preview).toEqual({
      ok: true,
      value: expect.objectContaining({
        confirmationToken: expect.any(String),
        ignoredEntryCount: 1,
        ignoredTopLevelEntries: ['.env'],
      }),
    });
    if (!preview.ok || preview.value.confirmationToken === null) {
      throw new Error(preview.ok ? 'Expected ignored-file confirmation.' : preview.error);
    }

    const secondCreated = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ignored-confirmation-two' },
      createdBy: 'user',
      name: 'ignored-confirmation-two',
      rootId: 'r-1',
    });
    if (!secondCreated.ok) {
      throw new Error(secondCreated.error);
    }
    writeFileSync(path.join(secondCreated.value.worktree.path, '.env'), 'SECRET=second\n');
    const secondPreview = await service.inspectArchive({
      worktreeId: secondCreated.value.worktree.id,
    });
    if (!(secondPreview.ok && secondPreview.value.confirmationToken)) {
      throw new Error(
        secondPreview.ok ? 'Expected ignored-file confirmation.' : secondPreview.error
      );
    }
    expect(secondPreview.value.confirmationToken).not.toBe(preview.value.confirmationToken);

    await expect(service.archive({ worktreeId: worktree.id })).resolves.toEqual({
      error:
        'This worktree has 1 ignored entry that is not in the archive snapshot and will be permanently deleted. Top-level paths: .env. Confirm this deletion to archive.',
      ok: false,
    });
    expect(existsSync(worktree.path)).toBe(true);

    writeFileSync(path.join(worktree.path, '.gitignore'), '.env\n.cache\n');
    writeFileSync(path.join(worktree.path, '.cache'), 'new ignored file\n');
    await expect(
      service.archive({
        confirmIgnoredEntries: preview.value.confirmationToken,
        force: true,
        worktreeId: worktree.id,
      })
    ).resolves.toEqual({
      error:
        'This worktree has 2 ignored entries that are not in the archive snapshot and will be permanently deleted. Top-level paths: .cache, .env. Confirm this deletion to archive.',
      ok: false,
    });
    expect(existsSync(worktree.path)).toBe(true);

    const currentPreview = await service.inspectArchive({ worktreeId: worktree.id });
    expect(currentPreview.ok).toBe(true);
    if (!(currentPreview.ok && currentPreview.value.confirmationToken)) {
      throw new Error(
        currentPreview.ok
          ? 'Expected the changed ignored-file set to require confirmation.'
          : currentPreview.error
      );
    }
    const archived = await service.archive({
      confirmIgnoredEntries: currentPreview.value.confirmationToken,
      force: true,
      worktreeId: worktree.id,
    });
    expect(archived.ok).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it('parses renamed paths and reports directory-shaped top-level entries', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.env\ndata/*.sqlite\nnode_modules/\n');
    writeFileSync(path.join(repo, '!! notes.txt'), 'tracked rename source\n');
    git(repo, ['add', '.gitignore', '!! notes.txt']);
    git(repo, ['commit', '-m', 'ignore generated logs']);
    const service = buildTestService({ db, managedDirectory, repo });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ignored-safety' },
      createdBy: 'user',
      name: 'ignored-safety',
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    const { worktree } = created.value;
    writeFileSync(path.join(worktree.path, '.env'), 'SECRET=test\n');
    mkdirSync(path.join(worktree.path, 'data'), { recursive: true });
    writeFileSync(path.join(worktree.path, 'data', 'local.sqlite'), 'local\n');
    mkdirSync(path.join(worktree.path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(worktree.path, 'node_modules', 'pkg', 'index.js'), 'x\n');
    const inspect = () =>
      inspectWorktreeSafety({
        baseRef: 'main',
        invoke: (args, timeoutMs = 5000) =>
          execFileGitRunner({ args, cwd: worktree.path, timeoutMs }),
        lockedReason: null,
        threadIsRunning: false,
        worktree: { id: worktree.id, path: worktree.path },
      });

    const report = await inspect();
    if (!report.ok) {
      throw new Error(report.error);
    }
    expect(report.value).toMatchObject({
      blockers: [],
      dirty: false,
      ignoredEntryCount: 3,
      ignoredTopLevelEntries: ['.env', 'data/', 'node_modules/'],
      ignoredTopLevelEntriesTruncated: false,
      ignoredTopLevelEntryCount: 3,
    });

    const originalConfirmationToken = report.value.ignoredEntriesConfirmationToken;
    writeFileSync(path.join(worktree.path, 'data', 'second.sqlite'), 'local-2\n');
    const changedReport = await inspect();
    if (!changedReport.ok) {
      throw new Error(changedReport.error);
    }
    expect(changedReport.value.ignoredEntryCount).toBe(4);
    expect(changedReport.value.ignoredTopLevelEntries).toEqual(['.env', 'data/', 'node_modules/']);
    expect(changedReport.value.ignoredEntriesConfirmationToken).toBe(originalConfirmationToken);

    git(worktree.path, ['mv', '!! notes.txt', 'renamed.txt']);
    const renamedReport = await inspect();
    if (!renamedReport.ok) {
      throw new Error(renamedReport.error);
    }
    expect(renamedReport.value.ignoredEntryCount).toBe(4);
    expect(renamedReport.value.ignoredTopLevelEntries).toEqual(['.env', 'data/', 'node_modules/']);
    expect(renamedReport.value.dirty).toBe(true);
  });

  it.each([
    ['snapshot capture', 'update-ref'],
    ['post-capture safety checks', 'rev-list'],
  ] as const)(
    'refuses when the ignored path set changes during %s',
    async (_phase, triggerArgument) => {
      writeFileSync(path.join(repo, '.gitignore'), '.env\n.late-secret\n');
      git(repo, ['add', '.gitignore']);
      git(repo, ['commit', '-m', 'ignore local secrets']);
      let lateSecretPath: string | null = null;
      const service = buildTestService(
        { db, managedDirectory, repo },
        {
          run: async (input) => {
            const result = await execFileGitRunner(input);
            if (input.args.includes(triggerArgument) && lateSecretPath !== null) {
              writeFileSync(lateSecretPath, 'created during archive\n');
              lateSecretPath = null;
            }
            return result;
          },
        }
      );
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/ignored-capture-race' },
        createdBy: 'user',
        name: 'ignored-capture-race',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error(created.error);
      }
      const { worktree } = created.value;
      writeFileSync(path.join(worktree.path, '.env'), 'SECRET=test\n');

      const preview = await service.inspectArchive({ worktreeId: worktree.id });
      expect(preview.ok).toBe(true);
      if (!(preview.ok && preview.value.confirmationToken)) {
        throw new Error(preview.ok ? 'Expected ignored-file confirmation.' : preview.error);
      }
      lateSecretPath = path.join(worktree.path, '.late-secret');

      await expect(
        service.archive({
          confirmIgnoredEntries: preview.value.confirmationToken,
          force: true,
          worktreeId: worktree.id,
        })
      ).resolves.toEqual({
        error:
          'This worktree has 2 ignored entries that are not in the archive snapshot and will be permanently deleted. Top-level paths: .env, .late-secret. Confirm this deletion to archive.',
        ok: false,
      });
      expect(existsSync(worktree.path)).toBe(true);
    }
  );

  it('reports the exact hidden top-level path count when the preview is bounded', async () => {
    const ignoredNames = Array.from(
      { length: 12 },
      (_, index) => `.secret-${String(index).padStart(2, '0')}`
    );
    writeFileSync(path.join(repo, '.gitignore'), `${ignoredNames.join('\n')}\n`);
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore local secrets']);
    const service = buildTestService({ db, managedDirectory, repo });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ignored-truncation' },
      createdBy: 'user',
      name: 'ignored-truncation',
      rootId: 'r-1',
    });
    if (!created.ok) {
      throw new Error(created.error);
    }
    for (const ignoredName of ignoredNames) {
      writeFileSync(path.join(created.value.worktree.path, ignoredName), 'secret\n');
    }

    const preview = await service.inspectArchive({ worktreeId: created.value.worktree.id });

    expect(preview).toEqual({
      ok: true,
      value: {
        confirmationToken: expect.any(String),
        ignoredEntryCount: 12,
        ignoredTopLevelEntries: ignoredNames.slice(0, 10),
        ignoredTopLevelEntriesTruncated: true,
        ignoredTopLevelEntryCount: 12,
      },
    });
    await expect(service.archive({ worktreeId: created.value.worktree.id })).resolves.toEqual({
      error: `This worktree has 12 ignored entries that are not in the archive snapshot and will be permanently deleted. Top-level paths: ${ignoredNames
        .slice(0, 10)
        .join(', ')}, and 2 other top-level paths. Confirm this deletion to archive.`,
      ok: false,
    });
  });
});
