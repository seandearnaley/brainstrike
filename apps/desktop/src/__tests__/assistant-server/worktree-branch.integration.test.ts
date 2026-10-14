// @vitest-environment node
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeLedger } from '../../assistant-server/worktree-ledger';
import {
  asLedgerStore,
  buildTestService,
  createTestWorkspace,
  git,
} from './worktree-service.shared';

describe('worktree branch attachment with real Git and SQLite', () => {
  let db: StateStore;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();
  const buildService = () => buildTestService({ db, managedDirectory, repo });
  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-branch-state-'));
    repo = workspace.freshRepo('branch-repo');
    managedDirectory = workspace.freshManagedDir();
  });
  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });
  describe('WorktreeService.createBranchHere', () => {
    it('attaches a new branch to a detached managed worktree and updates the ledger', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { detached: true },
        createdBy: 'user',
        name: 'detached-success',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const attached = await service.createBranchHere({
        branch: 'bs/attached',
        worktreeId: created.value.worktree.id,
      });
      expect(attached.ok).toBe(true);
      if (!attached.ok) {
        return;
      }
      expect(attached.value.branch).toBe('bs/attached');
      expect(git(attached.value.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'bs/attached'
      );
      const ledger = createWorktreeLedger(
        () => Promise.resolve(asLedgerStore(db)),
        async () => false
      );
      await expect(ledger.get(attached.value.id)).resolves.toMatchObject({ branch: 'bs/attached' });
    });

    it('refuses an existing local branch without mutating the detached worktree', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { detached: true },
        createdBy: 'user',
        name: 'detached-existing',
        rootId: 'r-1',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const refused = await service.createBranchHere({
        branch: 'main',
        worktreeId: created.value.worktree.id,
      });
      expect(refused).toEqual({ error: 'local branch "main" already exists', ok: false });
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'HEAD'
      );
      const ledger = createWorktreeLedger(
        () => Promise.resolve(asLedgerStore(db)),
        async () => false
      );
      await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({ branch: null });
    });

    it('refuses to create a branch when the managed worktree is already attached', async () => {
      const service = buildService();
      const created = await service.create({
        baseRef: 'main',
        branch: { name: 'bs/already-attached' },
        createdBy: 'user',
        name: 'already-attached',
        rootId: 'r-1',
      });
      if (!created.ok) {
        return;
      }

      const refused = await service.createBranchHere({
        branch: 'bs/must-not-replace',
        worktreeId: created.value.worktree.id,
      });

      expect(refused).toEqual({
        error: `Managed worktree "${created.value.worktree.id}" is attached to branch "bs/already-attached"; createBranchHere requires a detached worktree.`,
        ok: false,
      });
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe(
        'bs/already-attached'
      );
      const ledger = createWorktreeLedger(
        () => Promise.resolve(asLedgerStore(db)),
        async () => false
      );
      await expect(ledger.get(created.value.worktree.id)).resolves.toMatchObject({
        branch: 'bs/already-attached',
      });
    });

    it('refuses an unknown worktree id', async () => {
      const service = buildService();
      await expect(
        service.createBranchHere({ branch: 'bs/nope', worktreeId: 'unknown-worktree' })
      ).resolves.toEqual({
        error: 'Managed worktree "unknown-worktree" is not active.',
        ok: false,
      });
    });
  });
});
