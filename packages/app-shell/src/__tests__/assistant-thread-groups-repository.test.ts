import type { DbHandle } from '@brainstrike/db';
import { describe, expect, it, vi } from 'vitest';
import { createPgliteAssistantThreadGroupsRepository } from '../assistant-thread-groups-repository';

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

describe('createPgliteAssistantThreadGroupsRepository', () => {
  it('caches the repository per database handle', () => {
    const db = createMockDb();
    const first = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);
    const second = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);
    expect(first).toBe(second);
  });

  it('creates a group and returns it', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    const group = await repository.createGroup('workspace-a', '  Research  ', 'a0');

    expect(group.name).toBe('Research');
    expect(group.rank).toBe('a0');
    expect(group.resourceId).toBe('workspace-a');
    expect(group.id).toMatch(/^thread-group-/);
    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('INSERT INTO brainstrike_assistant_thread_groups');
    expect(params).toEqual([group.id, 'workspace-a', 'Research', 'a0']);
  });

  it('rejects a group with an empty name', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await expect(repository.createGroup('workspace-a', '   ', 'a0')).rejects.toThrow(
      'Thread group name is required.'
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a group with an empty rank', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await expect(repository.createGroup('workspace-a', 'Research', '')).rejects.toThrow(
      'Thread group rank is required.'
    );
  });

  it('lists groups ordered by rank and maps rows', async () => {
    const db = createMockDb();
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM brainstrike_assistant_thread_groups')) {
        return {
          rows: [
            { id: 'thread-group-1', name: 'Research', rank: 'a0', resourceId: 'workspace-a' },
            { id: 'thread-group-2', name: 'Bugs', rank: 'a1', resourceId: 'workspace-a' },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    const groups = await repository.listGroups('workspace-a');

    expect(groups).toEqual([
      { id: 'thread-group-1', name: 'Research', rank: 'a0', resourceId: 'workspace-a' },
      { id: 'thread-group-2', name: 'Bugs', rank: 'a1', resourceId: 'workspace-a' },
    ]);
    const [sql] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('ORDER BY rank');
  });

  it('throws on a malformed group row instead of coercing', async () => {
    const db = createMockDb();
    db.query.mockResolvedValue({
      rows: [{ id: 42, name: 'Research', rank: 'a0', resourceId: 'workspace-a' }],
    });
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await expect(repository.listGroups('workspace-a')).rejects.toThrow('id is not a string');
  });

  it('renames a group with a trimmed title and rejects empty names', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.renameGroup('thread-group-1', ' Deep Work ');
    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('UPDATE brainstrike_assistant_thread_groups');
    expect(params?.[0]).toBe('thread-group-1');
    expect(params?.[1]).toBe('Deep Work');

    await expect(repository.renameGroup('thread-group-1', '  ')).rejects.toThrow(
      'Thread group name is required.'
    );
  });

  it('updates a group rank', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setGroupRank('thread-group-1', 'a2');

    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('UPDATE brainstrike_assistant_thread_groups');
    expect(String(sql)).toContain('rank');
    expect(params).toEqual(['thread-group-1', 'a2']);
  });

  it('deletes a group and its placements so threads return to Ungrouped', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.deleteGroup('thread-group-1');

    const calls = db.query.mock.calls.map(([sql]) => String(sql));
    expect(calls[0]).toContain('DELETE FROM brainstrike_assistant_thread_placements');
    expect(calls[1]).toContain('DELETE FROM brainstrike_assistant_thread_groups');
  });

  it('upserts a thread placement keyed by thread id', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setThreadPlacement({
      groupId: 'thread-group-1',
      rank: 'a0',
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('INSERT INTO brainstrike_assistant_thread_placements');
    expect(String(sql)).toContain('ON CONFLICT (thread_id) DO UPDATE');
    expect(params).toEqual(['thread-1', 'workspace-a', 'thread-group-1', 'a0']);
  });

  it('accepts a null group id for a manually ranked ungrouped thread', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setThreadPlacement({
      groupId: null,
      rank: 'a1',
      resourceId: 'workspace-a',
      threadId: 'thread-1',
    });

    const [, params] = db.query.mock.calls[0] ?? [];
    expect(params).toEqual(['thread-1', 'workspace-a', null, 'a1']);
  });

  it('rejects a placement with an empty rank', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await expect(
      repository.setThreadPlacement({
        groupId: null,
        rank: ' ',
        resourceId: 'workspace-a',
        threadId: 'thread-1',
      })
    ).rejects.toThrow('Thread placement rank is required.');
  });

  it('lists placements and preserves null group ids', async () => {
    const db = createMockDb();
    db.query.mockResolvedValue({
      rows: [
        { groupId: 'thread-group-1', rank: 'a0', resourceId: 'workspace-a', threadId: 'thread-1' },
        { groupId: null, rank: 'a1', resourceId: 'workspace-a', threadId: 'thread-2' },
      ],
    });
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    const placements = await repository.listPlacements('workspace-a');

    expect(placements).toEqual([
      { groupId: 'thread-group-1', rank: 'a0', resourceId: 'workspace-a', threadId: 'thread-1' },
      { groupId: null, rank: 'a1', resourceId: 'workspace-a', threadId: 'thread-2' },
    ]);
  });

  it('clears a thread placement', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.clearThreadPlacement('thread-1');

    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('DELETE FROM brainstrike_assistant_thread_placements');
    expect(params).toEqual(['thread-1']);
  });
});

describe('batch writes are single atomic statements', () => {
  it('upserts many placements in one multi-row statement', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setThreadPlacements([
      { groupId: 'thread-group-1', rank: 'a0', resourceId: 'workspace-a', threadId: 'thread-1' },
      { groupId: null, rank: 'a1', resourceId: 'workspace-a', threadId: 'thread-2' },
    ]);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('INSERT INTO brainstrike_assistant_thread_placements');
    expect(String(sql)).toContain('ON CONFLICT (thread_id) DO UPDATE');
    expect(String(sql)).toContain('($1, $2, $3, $4)');
    expect(String(sql)).toContain('($5, $6, $7, $8)');
    expect(params).toEqual([
      'thread-1',
      'workspace-a',
      'thread-group-1',
      'a0',
      'thread-2',
      'workspace-a',
      null,
      'a1',
    ]);
  });

  it('is a no-op for an empty placement batch', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setThreadPlacements([]);

    expect(db.query).not.toHaveBeenCalled();
  });

  it('rejects a batch containing an empty rank before writing', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await expect(
      repository.setThreadPlacements([
        { groupId: null, rank: ' ', resourceId: 'workspace-a', threadId: 'thread-1' },
      ])
    ).rejects.toThrow('Thread placement rank is required.');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('updates many group ranks in one statement', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setGroupRanks([
      { groupId: 'thread-group-2', rank: 'a0' },
      { groupId: 'thread-group-1', rank: 'a1' },
    ]);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('UPDATE brainstrike_assistant_thread_groups');
    expect(String(sql)).toContain('FROM (VALUES');
    expect(params).toEqual(['thread-group-2', 'a0', 'thread-group-1', 'a1']);
  });

  it('is a no-op for an empty group-rank batch', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadGroupsRepository(db as unknown as DbHandle);

    await repository.setGroupRanks([]);

    expect(db.query).not.toHaveBeenCalled();
  });
});
