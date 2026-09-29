import type { DbHandle } from '@brainstrike/db/react';
import { describe, expect, it, vi } from 'vitest';
import { createThreadWorkspaceRepository } from '../thread-workspace-repository';
import { EMPTY_WORKSPACE_SNAPSHOT, type WorkspaceSnapshotV1 } from '../thread-workspace-snapshot';

function createMockDb(): {
  exec: ReturnType<typeof vi.fn<(sql: string) => Promise<unknown>>>;
  query: ReturnType<
    typeof vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>
  >;
} {
  return {
    exec: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ rows: [] })),
  };
}

const SNAPSHOT: WorkspaceSnapshotV1 = {
  ...EMPTY_WORKSPACE_SNAPSHOT,
  apps: { openAppIds: ['context-explorer'], selection: { appId: 'context-explorer', kind: 'app' } },
};

describe('createThreadWorkspaceRepository', () => {
  it('caches the repository per database handle', () => {
    const db = createMockDb();
    const first = createThreadWorkspaceRepository(db as unknown as DbHandle);
    const second = createThreadWorkspaceRepository(db as unknown as DbHandle);
    expect(first).toBe(second);
  });

  it('upserts a snapshot keyed by thread id', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);

    db.query.mockResolvedValueOnce({ rows: [{ thread_id: 'thread-1' }] });
    await repository.setThreadWorkspace('thread-1', 'brainstrike:workspace', SNAPSHOT);

    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('INSERT INTO brainstrike_assistant_thread_workspaces');
    expect(String(sql)).toContain('ON CONFLICT (thread_id) DO UPDATE');
    expect(params?.[0]).toBe('thread-1');
    expect(params?.[1]).toBe('brainstrike:workspace');
    expect(JSON.parse(String(params?.[2]))).toEqual(SNAPSHOT);
  });

  it('preserves actual database failures instead of treating them as deleted owners', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);
    const failure = new Error('Database write failed');
    db.query.mockRejectedValueOnce(failure);
    await expect(repository.setThreadWorkspace('thread-1', 'owner', SNAPSHOT)).rejects.toBe(
      failure
    );
  });

  it('rejects blank thread/resource ids without touching the database', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);

    await expect(repository.setThreadWorkspace('  ', 'r', SNAPSHOT)).rejects.toThrow(/thread id/i);
    await expect(repository.setThreadWorkspace('t', '', SNAPSHOT)).rejects.toThrow(/resource id/i);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns null for a missing row and a coerced snapshot for a present one', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);

    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await repository.getThreadWorkspace('thread-x')).toBeNull();

    db.query.mockResolvedValueOnce({ rows: [{ payload: SNAPSHOT, threadId: 'thread-1' }] });
    expect(await repository.getThreadWorkspace('thread-1')).toEqual(SNAPSHOT);
  });

  it('coerces malformed payloads at the read boundary instead of throwing', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      db.query.mockResolvedValueOnce({
        rows: [{ payload: { version: 99 }, threadId: 'thread-1' }],
      });
      expect(await repository.getThreadWorkspace('thread-1')).toEqual(EMPTY_WORKSPACE_SNAPSHOT);
    } finally {
      error.mockRestore();
    }
  });

  it('batch-gets snapshots as a map, skipping missing threads', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);

    db.query.mockResolvedValueOnce({
      rows: [
        { payload: SNAPSHOT, threadId: 'thread-1' },
        { payload: EMPTY_WORKSPACE_SNAPSHOT, threadId: 'thread-3' },
      ],
    });
    const map = await repository.getThreadWorkspaces(['thread-1', 'thread-2', 'thread-3']);
    expect([...map.keys()].sort()).toEqual(['thread-1', 'thread-3']);
    expect(map.get('thread-1')).toEqual(SNAPSHOT);

    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('= ANY($1)');
    expect(params?.[0]).toEqual(['thread-1', 'thread-2', 'thread-3']);
  });

  it('batch-get with no ids resolves empty without querying', async () => {
    const db = createMockDb();
    const repository = createThreadWorkspaceRepository(db as unknown as DbHandle);
    expect((await repository.getThreadWorkspaces([])).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
