// @vitest-environment node

/**
 * The picker-less mount authorization seam (`isManagedWorktreePath` →
 * `isAuthorizedWorktreeMountPath`), over real git + real SQLite — extracted
 * from `worktree-service.integration.test.ts` when the BST-1392 follow-up
 * widening pushed that file over the 1000-line ceiling. Same harness
 * (`worktree-service.shared.ts`); the whole authorization concern lives here.
 */
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import type { GitInventory } from '@brainstrike/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerWarnSpy = vi.hoisted(() => vi.fn());
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return { ...real, warn: loggerWarnSpy };
    },
  };
});

import type { createWorktreeService } from '../../assistant-server/worktree-service';
import { buildTestService, createTestWorkspace, git } from './worktree-service.shared';

describe('WorktreeService mount authorization (real git + real SQLite)', () => {
  let db: StateStore;
  let repo: string;
  let managedDirectory: string;
  const workspace = createTestWorkspace();

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);

  beforeEach(async () => {
    loggerWarnSpy.mockClear();
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-state-'));
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
    const resolveInventory = vi.fn(() => Promise.resolve(inRootInventory));
    const service = buildService({ resolveInventory });
    const adopted = await service.adopt({ createdBy: 'user', path: canonicalPath });
    expect(adopted.ok).toBe(true);

    // The widened grant: live ledger row + in-root containment mounts without
    // a picker — called with the RAW (un-realpath'd) path to also pin the
    // realpath normalization.
    resolveInventory.mockClear();
    await expect(service.isManagedWorktreePath(worktreePath)).resolves.toBe(true);
    // FORCED-FRESH (PR #2681 review): a `roots` write never dirties the
    // cached inventory snapshot, so authorizing against the default cached
    // read could honor a root the user closed seconds ago (or refuse one
    // they just granted). The authorizer must demand a fresh build.
    expect(resolveInventory).toHaveBeenCalledWith({ forceFresh: true });

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

  it('keeps the managed-directory arm inventory-free and WARNS when the inventory is unavailable (PR #2681 review)', async () => {
    // Managed-directory candidate: created by the app, live ledger row. The
    // managed arm must authorize even while the inventory is down — that arm
    // reads settings + realpath only, never the inventory.
    const broken = () => Promise.reject(new Error('inventory stopped'));
    const service = buildService({ resolveInventory: broken });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/inventory-down' },
      createdBy: 'user',
      name: 'inventory-down',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    loggerWarnSpy.mockClear();
    await expect(service.isManagedWorktreePath(created.value.worktree.path)).resolves.toBe(true);

    // An in-root candidate (adopted while the inventory was healthy) is
    // refused while the inventory is unavailable — fail closed for the arm
    // that NEEDS the inventory — and the failure surfaces at WARN, never a
    // silent debug-only false (NO SILENT FALLBACKS).
    const worktreePath = path.join(repo, '.claude', 'worktrees', 'inventory-down-nested');
    git(repo, ['worktree', 'add', '-b', 'bs/inventory-down-nested', worktreePath, 'HEAD']);
    const canonicalPath = realpathSync(worktreePath);
    const canonicalRepo = realpathSync(repo);
    const healthyInventory = {
      errors: [],
      repositories: [
        {
          identity: {
            gitCommonDir: path.join(canonicalRepo, '.git'),
            repositoryRoot: canonicalRepo,
          },
          worktrees: [
            {
              bare: false,
              branch: 'bs/inventory-down-nested',
              containment: ['r-1'] as readonly string[] | 'outside-roots',
              current: false,
              detached: false,
              head: 'abc123',
              lockedReason: null,
              name: 'inventory-down-nested',
              path: canonicalPath,
              provenance: 'scanned' as const,
              prunableReason: null,
              trust: 'validated' as const,
              trustReason: null,
            },
          ],
        },
      ],
    } satisfies GitInventory;
    const healthy = buildService({ resolveInventory: () => Promise.resolve(healthyInventory) });
    const adopted = await healthy.adopt({ createdBy: 'user', path: canonicalPath });
    expect(adopted.ok).toBe(true);

    loggerWarnSpy.mockClear();
    await expect(service.isManagedWorktreePath(canonicalPath)).resolves.toBe(false);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'inventory unavailable during mount authorization; managed-directory arm only',
      expect.objectContaining({ candidate: canonicalPath })
    );
  });
});
