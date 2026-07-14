import { type DbHandle, wasmLoader } from '@brainstrike/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteAssistantThreadGroupsRepository } from '../assistant-thread-groups-repository';

describe('createPgliteAssistantThreadGroupsRepository integration', () => {
  let db: Awaited<ReturnType<typeof wasmLoader.createPGlite>> | undefined;

  afterEach(async () => {
    await db?.close();
    db = undefined;
  });

  it('preserves placement ranks when deleting a group in real PGlite', async () => {
    db = await wasmLoader.createPGlite(
      `memory://assistant-thread-group-delete-${crypto.randomUUID()}`
    );
    await db.exec(`
      CREATE TABLE brainstrike_assistant_thread_groups (
        id text PRIMARY KEY,
        resource_id text NOT NULL,
        name text NOT NULL,
        rank text NOT NULL,
        color text,
        icon text,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );
      CREATE TABLE brainstrike_assistant_thread_placements (
        thread_id text PRIMARY KEY,
        resource_id text NOT NULL,
        group_id text,
        rank text NOT NULL,
        flat_rank text,
        updated_at timestamptz NOT NULL DEFAULT NOW()
      );

      INSERT INTO brainstrike_assistant_thread_groups
        (id, resource_id, name, rank)
      VALUES
        ('group-delete', 'workspace-a', 'Delete me', 'a0'),
        ('group-keep', 'workspace-a', 'Keep me', 'a1');
      INSERT INTO brainstrike_assistant_thread_placements
        (thread_id, resource_id, group_id, rank, flat_rank)
      VALUES
        ('thread-moved', 'workspace-a', 'group-delete', 'group-rank', 'flat-rank'),
        ('thread-kept', 'workspace-a', 'group-keep', 'kept-group-rank', 'kept-flat-rank');
    `);
    const repository = createPgliteAssistantThreadGroupsRepository(db as DbHandle);

    await repository.deleteGroup('group-delete');

    const placements = await db.query<{
      flat_rank: string;
      group_id: string | null;
      rank: string;
      thread_id: string;
    }>(
      `SELECT thread_id, group_id, rank, flat_rank
       FROM brainstrike_assistant_thread_placements
       ORDER BY thread_id`
    );
    const groups = await db.query<{ id: string }>(
      'SELECT id FROM brainstrike_assistant_thread_groups ORDER BY id'
    );

    expect(placements.rows).toEqual([
      {
        flat_rank: 'kept-flat-rank',
        group_id: 'group-keep',
        rank: 'kept-group-rank',
        thread_id: 'thread-kept',
      },
      {
        flat_rank: 'flat-rank',
        group_id: null,
        rank: 'group-rank',
        thread_id: 'thread-moved',
      },
    ]);
    expect(groups.rows).toEqual([{ id: 'group-keep' }]);
  });
});
