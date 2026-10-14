// @vitest-environment node

/** Worktree outcomes belong to the SQLite ledger and the host-owned tool result. */
import { rmSync } from 'node:fs';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { createWorktreeService } from '../../assistant-server/worktree-service';
import { buildTestService, createTestWorkspace } from './worktree-service.shared';

describe('worktree run outcomes (real SQLite and Git)', () => {
  let db: StateStore;
  let managedDirectory: string;
  let repo: string;
  const workspace = createTestWorkspace();
  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    buildTestService({ db, managedDirectory, repo }, overrides);
  const params = {
    baseRef: 'main',
    branch: { name: 'bs/outcome' },
    createdBy: 'user' as const,
    name: 'outcome',
    rootId: 'r-1',
    runId: 'run-outcome',
    threadId: 'thread-outcome',
  };

  beforeEach(async () => {
    db = await StateStore.open(workspace.freshTempDir('bst-worktree-outcomes-'));
    repo = workspace.freshRepo('outcomes');
    managedDirectory = workspace.freshManagedDir();
  });
  afterEach(async () => {
    await db.close();
    workspace.cleanup();
  });

  it.each(['user', 'agent'] as const)(
    'preserves %s creation provenance without a legacy run parent',
    async (createdBy) => {
      const created = await buildService().create({ ...params, createdBy });
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error(created.error);
      }
      const stored = await db.worktreeLedger({ id: created.value.worktree.id, operation: 'get' });
      expect(stored.rows).toEqual([created.value.worktree]);
      expect(stored.rows[0]).toMatchObject({
        createdBy,
        runId: params.runId,
        threadId: params.threadId,
      });
    }
  );

  it('creates a user worktree without an active run', async () => {
    const { runId: _runId, threadId: _threadId, ...withoutRun } = params;
    const created = await buildService().create(withoutRun);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.value.worktree).toMatchObject({
      createdBy: 'user',
      runId: null,
      threadId: null,
    });
  });

  it('returns and persists failed setup without failing the created worktree', async () => {
    const setup = {
      copiedPaths: ['config.json'],
      output: 'boom',
      reason: 'Setup command exited with code 3.',
      skippedCopies: [],
      status: 'failed' as const,
      truncated: true,
    };
    const created = await buildService({ runSetup: async () => setup }).create(params);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.value.setup).toEqual(setup);
    expect(created.value.worktree).toMatchObject({
      setupOutput: setup.output,
      setupReason: setup.reason,
      setupStatus: setup.status,
    });
    expect(
      (await db.worktreeLedger({ id: created.value.worktree.id, operation: 'get' })).rows
    ).toEqual([created.value.worktree]);
  });

  it('preserves thrown setup failure as the operation result and ledger state', async () => {
    const failure = new Error('setup process failed');
    const created = await buildService({
      runSetup: async () => {
        throw failure;
      },
    }).create(params);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error);
    }
    expect(created.value.setup.status).toBe('failed');
    expect(created.value.setup.reason).toContain(failure.message);
    expect(created.value.worktree.setupReason).toBe(created.value.setup.reason);
  });

  it.each([false, true])(
    'preserves archive snapshot in result and ledger (missing=%s)',
    async (missing) => {
      const service = buildService();
      const created = await service.create(params);
      expect(created.ok).toBe(true);
      if (!created.ok) {
        throw new Error(created.error);
      }
      if (missing) {
        rmSync(created.value.worktree.path, { force: true, recursive: true });
      }
      const archived = await service.archive({
        runId: params.runId,
        worktreeId: created.value.worktree.id,
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) {
        throw new Error(archived.error);
      }
      expect(archived.value.snapshotRef).toBe(
        `refs/brainstrike/worktree-archive/${created.value.worktree.id}`
      );
      expect(archived.value.worktree.archiveSnapshotRef).toBe(archived.value.snapshotRef);
      expect(archived.value.worktree.archivedAt).not.toBeNull();
      expect(
        (await db.worktreeLedger({ id: created.value.worktree.id, operation: 'get' })).rows
      ).toEqual([archived.value.worktree]);
    }
  );
});
