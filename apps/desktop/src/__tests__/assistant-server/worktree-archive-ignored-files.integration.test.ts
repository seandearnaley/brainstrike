import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileGitRunner } from '../../git-ipc-handlers';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

describe('WorktreeService ignored-file archive confirmation (real git + real PGlite)', () => {
  let db: PGlite;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
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

  it('refuses when the ignored path set changes during snapshot capture', async () => {
    writeFileSync(path.join(repo, '.gitignore'), '.env\n.late-secret\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore local secrets']);
    let lateSecretPath: string | null = null;
    const service = buildTestService(
      { db, managedDirectory, repo },
      {
        run: async (input) => {
          const result = await execFileGitRunner(input);
          if (input.args.includes('update-ref') && lateSecretPath !== null) {
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
  });
});
