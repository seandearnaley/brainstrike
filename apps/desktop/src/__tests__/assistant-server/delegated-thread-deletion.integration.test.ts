import {
  createPgliteAssistantThreadRepository,
  createThreadWorkspaceRepository,
  EMPTY_WORKSPACE_SNAPSHOT,
} from '@brainstrike/assistant-data';
import { ThreadSearchRepository, ToolOutputArtifactRepository } from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import { createMigratedTestDb } from '@brainstrike/db/test-support/migrated-test-db';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe.each(['single', 'bulk'] as const)('ordinary web thread deletion (%s)', (mode) => {
  let database: PGlite;
  beforeEach(async () => {
    database = await createMigratedTestDb();
    for (const id of ['root', 'child', 'grandchild', 'sibling', 'unrelated']) {
      await database.query(
        `INSERT INTO mastra_threads
        (id, "resourceId", title, metadata, "createdAt", "updatedAt")
        VALUES ($1, $2, $1, '{}', NOW(), NOW())`,
        [id, `owner-${id}`]
      );
      await database.query(
        `INSERT INTO mastra_messages
        (id, thread_id, content, role, type, "createdAt", "resourceId")
        VALUES ($1, $1, '{"content":"message"}', 'user', 'text', NOW(), $2)`,
        [id, `owner-${id}`]
      );
      await database.query(
        `INSERT INTO brainstrike_assistant_message_tombstones
        (message_id, thread_id, rewind_id) VALUES ($1, $1, 'rewind')`,
        [id]
      );
      await createThreadWorkspaceRepository(database as unknown as DbHandle).setThreadWorkspace(
        id,
        `owner-${id}`,
        EMPTY_WORKSPACE_SNAPSHOT
      );
      await database.query(
        `INSERT INTO brainstrike_assistant_thread_runs
        (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
        VALUES ($1, $2, $1, 'openai', 'test', 'desktop', 'completed', NOW(), NOW(), NOW(), $1)`,
        [id, `owner-${id}`]
      );
      await database.query(
        `INSERT INTO brainstrike_assistant_run_events
        (id, run_id, resource_id, thread_id, sequence, kind, status, label, metadata, occurred_at, created_at, updated_at)
        VALUES ($1, $1, $2, $1, 1, 'tool-call', 'completed', 'Read source', '{"toolCallId":"read"}', NOW(), NOW(), NOW())`,
        [id, `owner-${id}`]
      );
      // Child artifacts are readable through their owning root, but retain
      // execution provenance. Deleting only that child must erase its bytes.
      const ownerThreadId = id;
      await new ToolOutputArtifactRepository(database).store({
        content: `Private tool output for ${id}`,
        executionThreadId: id,
        format: 'text',
        resourceId: `owner-${ownerThreadId}`,
        runId: id,
        threadId: ownerThreadId,
        toolCallId: 'read',
      });
    }
    await new ThreadSearchRepository(database).sync();
  }, 30_000);
  afterEach(async () => {
    await database.close();
  });

  async function deleteBranch(threadId: string): Promise<void> {
    const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
    if (mode === 'bulk') {
      await repository.deleteThreads([threadId]);
      return;
    }
    await repository.deleteThread(threadId);
  }

  it.each(['root', 'child'])(
    'deletes only the requested thread and its sidecars (%s)',
    async (root) => {
      await deleteBranch(root);
      const expected = ['child', 'grandchild', 'root', 'sibling', 'unrelated'].filter(
        (id) => id !== root
      );
      for (const [table, column] of [
        ['mastra_threads', 'id'],
        ['mastra_messages', 'thread_id'],
        ['brainstrike_assistant_message_tombstones', 'thread_id'],
        ['brainstrike_assistant_thread_runs', 'thread_id'],
        ['brainstrike_assistant_run_events', 'thread_id'],
        ['brainstrike_assistant_thread_workspaces', 'thread_id'],
        ['brainstrike_assistant_tool_output_artifacts', 'execution_thread_id'],
        ['brainstrike_thread_message_index', 'thread_id'],
        ['brainstrike_thread_search_state', 'thread_id'],
      ]) {
        const result = await database.query<{ id: string }>(
          `SELECT ${column} AS id FROM ${table} ORDER BY ${column}`
        );
        expect
          .soft(
            result.rows.map((row) => row.id),
            table
          )
          .toEqual(expected);
      }
      const deleted = [root];
      const ops = await database.query<{ entity_id: string; resource_id: string }>(
        'SELECT entity_id, resource_id FROM brainstrike_mind_ops ORDER BY entity_id'
      );
      expect(ops.rows).toEqual(
        deleted.map((id) => ({ entity_id: id, resource_id: `owner-${id}` }))
      );
    }
  );

  it('rejects late workspace saves after deletion and saves by a revoked native owner', async () => {
    const workspaces = createThreadWorkspaceRepository(database as unknown as DbHandle);
    await deleteBranch('root');
    await expect(
      workspaces.setThreadWorkspace('root', 'owner-root', EMPTY_WORKSPACE_SNAPSHOT)
    ).rejects.toThrow(/workspace owner/u);
    expect(await workspaces.getThreadWorkspace('root')).toBeNull();
    await expect(
      workspaces.setThreadWorkspace('unrelated', 'wrong-owner', EMPTY_WORKSPACE_SNAPSHOT)
    ).rejects.toThrow(/workspace owner/u);
    await expect(
      workspaces.setThreadWorkspace('unrelated', 'owner-unrelated', EMPTY_WORKSPACE_SNAPSHOT)
    ).resolves.toBeUndefined();
  });

  it('retains spent usage when deleting a child or its root conversation', async () => {
    await database.exec(`INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at, turn_message_id)
      VALUES ('host', 'owner-root', 'root', 'openai', 'test', 'desktop', 'completed', NOW(), NOW(), NOW(), 'turn');
      INSERT INTO brainstrike_assistant_run_usage
      (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind)
      VALUES ('usage', 'root', 'host', 'owner-root', 'test', 'openai', 10, 5, 'chat');`);
    await deleteBranch('child');
    expect(
      (
        await database.query(`SELECT input_tokens, output_tokens
      FROM brainstrike_assistant_run_usage`)
      ).rows
    ).toEqual([
      {
        input_tokens: 10,
        output_tokens: 5,
      },
    ]);
    await deleteBranch('root');
    // Numeric usage history already survives root deletion; it is not a transcript sidecar.
    expect((await database.query('SELECT id FROM brainstrike_assistant_run_usage')).rows).toEqual([
      { id: 'usage' },
    ]);
    expect((await database.query("SELECT id FROM mastra_threads WHERE id = 'root'")).rows).toEqual(
      []
    );
  });

  if (mode === 'bulk') {
    it('validates every requested thread before deleting the selected set atomically', async () => {
      const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
      await expect(repository.deleteThreads(['root', 'missing'])).rejects.toThrow();
      expect((await database.query('SELECT id FROM mastra_threads')).rows).toHaveLength(5);
      expect((await database.query('SELECT seq FROM brainstrike_mind_ops')).rows).toEqual([]);
      await repository.deleteThreads(['root', 'child', 'unrelated']);
      expect((await database.query('SELECT id FROM mastra_threads ORDER BY id')).rows).toEqual([
        { id: 'grandchild' },
        { id: 'sibling' },
      ]);
      expect(
        (await database.query('SELECT entity_id FROM brainstrike_mind_ops')).rows
      ).toHaveLength(3);
    });
  }
});
