/**
 * The picker-less mount authorization seam (`isManagedWorktreePath` →
 * `isAuthorizedWorktreeMountPath`), over real git + real PGlite — extracted
 * from `worktree-service.integration.test.ts` when the BST-1392 follow-up
 * widening pushed that file over the 1000-line ceiling. Same harness
 * (`worktree-service.shared.ts`); the whole authorization concern lives here.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { runDrizzleMigrations as runMigrations } from '@brainstrike/db';
import type { GitInventory } from '@brainstrike/types';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { createWorktreeService } from '../../assistant-server/worktree-service';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

describe('WorktreeService mount authorization (real git + real PGlite)', () => {
  let db: PGlite;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    repo = workspace.freshRepo('repo');
    managedDirectory = workspace.freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it('authorizes a live ledger path under the managed directory and refuses row-less paths', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/grant' },
      createdBy: 'user',
      name: 'grant-me',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await expect(service.isManagedWorktreePath(created.value.worktree.path)).resolves.toBe(true);
    await expect(service.isManagedWorktreePath(repo)).resolves.toBe(false);
    mkdirSync(path.join(managedDirectory, 'not-a-row'), { recursive: true });
    await expect(
      service.isManagedWorktreePath(path.join(managedDirectory, 'not-a-row'))
    ).resolves.toBe(false);
  });

  it('authorizes an ADOPTED in-root worktree outside the managed directory, refusing it once outside-roots (BST-1392 follow-up)', async () => {
    // The containment class the desktop e2e's managed-external fixture misses:
    // a worktree nested INSIDE the granted root (the `.claude/worktrees/<name>`
    // shape every external tool uses), so adoption's `assertReachable` accepts
    // it while the old managed-directory-only mount rule refused it.
    const worktreePath = path.join(repo, '.claude', 'worktrees', 'adopted-nested');
    git(repo, ['worktree', 'add', '-b', 'bs/adopted-nested', worktreePath, 'HEAD']);
    const canonicalPath = realpathSync(worktreePath);
    const canonicalRepo = realpathSync(repo);
    const identity = {
      gitCommonDir: path.join(canonicalRepo, '.git'),
      repositoryRoot: canonicalRepo,
    };
    const descriptor = {
      bare: false,
      branch: 'bs/adopted-nested',
      containment: ['r-1'] as readonly string[] | 'outside-roots',
      current: false,
      detached: false,
      head: 'abc123',
      lockedReason: null,
      name: 'adopted-nested',
      path: canonicalPath,
      provenance: 'scanned' as const,
      prunableReason: null,
      trust: 'validated' as const,
      trustReason: null,
    };
    const inRootInventory = {
      errors: [],
      repositories: [{ identity, worktrees: [descriptor] }],
    } satisfies GitInventory;
    const service = buildService({
      resolveInventory: () => Promise.resolve(inRootInventory),
    });
    const adopted = await service.adopt({ createdBy: 'user', path: canonicalPath });
    expect(adopted.ok).toBe(true);

    // The widened grant: live ledger row + in-root containment mounts without
    // a picker — called with the RAW (un-realpath'd) path to also pin the
    // realpath normalization.
    await expect(service.isManagedWorktreePath(worktreePath)).resolves.toBe(true);

    // Pin the refusal that must survive the widening: the SAME live row, once
    // the inventory reports it outside every root (its granting root was
    // disconnected after adoption), no longer authorizes a mount.
    const disconnected = buildService({
      resolveInventory: () =>
        Promise.resolve({
          errors: [],
          repositories: [
            {
              identity,
              worktrees: [{ ...descriptor, containment: 'outside-roots' as const }],
            },
          ],
        } satisfies GitInventory),
    });
    await expect(disconnected.isManagedWorktreePath(worktreePath)).resolves.toBe(false);

    // And a live row the inventory does not report at all (not under the
    // managed directory either) stays refused rather than fail-open.
    const unreported = buildService();
    await expect(unreported.isManagedWorktreePath(worktreePath)).resolves.toBe(false);
  });
});
