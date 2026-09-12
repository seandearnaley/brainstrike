import { PgliteMemoryStore } from '@brainstrike/agent/pglite-mastra-memory';
import {
  createPgliteAssistantThreadRepository,
  createThreadWorkspaceRepository,
  EMPTY_WORKSPACE_SNAPSHOT,
} from '@brainstrike/assistant-data';
import {
  createDelegatedConversationRepository,
  migrate,
  ThreadSearchRepository,
  ToolOutputArtifactRepository,
  wasmLoader,
} from '@brainstrike/db';
import type { DbHandle } from '@brainstrike/db/react';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe.each(['single', 'bulk', 'native'] as const)('delegated branch deletion (%s)', (mode) => {
  let database: PGlite;
  beforeEach(async () => {
    database = await wasmLoader.createPGlite('memory://delegated-delete');
    await migrate(database);
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
      const ownerThreadId = id === 'unrelated' ? id : 'root';
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
    const graph = createDelegatedConversationRepository(database);
    const scope = { ownerResourceId: 'owner-root', rootThreadId: 'root' };
    await graph.registerRoot(scope);
    for (const [id, parent] of [
      ['child', 'root'],
      ['grandchild', 'child'],
      ['sibling', 'root'],
    ] as const) {
      await graph.createChild(scope, {
        color: 'blue',
        configuration: { personaId: 'explore' },
        displayName: id,
        parentThreadId: parent,
        resourceId: `owner-${id}`,
        threadId: id,
      });
    }
  }, 30_000);
  afterEach(async () => {
    await database.close();
  });

  async function deleteBranch(threadId: string): Promise<void> {
    if (mode === 'native') {
      await new PgliteMemoryStore({
        database: {
          exec: (sql) => database.exec(sql),
          query: (sql, values) => database.query(sql, values ? [...values] : undefined),
          transaction: (operation) =>
            database.transaction((tx) =>
              operation({
                exec: (sql) => tx.exec(sql),
                query: (sql, values) => tx.query(sql, values ? [...values] : undefined),
              })
            ),
        },
      }).deleteThread({ threadId });
      return;
    }
    const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
    if (mode === 'bulk') {
      await repository.deleteThreads([threadId]);
      return;
    }
    await repository.deleteThread(threadId);
  }

  it.each(['root', 'child'])(
    'deletes the full native subtree and its sidecars (%s)',
    async (root) => {
      await deleteBranch(root);
      const expected = root === 'root' ? ['unrelated'] : ['root', 'sibling', 'unrelated'];
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
      const deleted =
        root === 'root' ? ['child', 'grandchild', 'root', 'sibling'] : ['child', 'grandchild'];
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
      INSERT INTO brainstrike_delegated_invocations
      (owner_resource_id, root_thread_id, thread_id, host_run_id, turn_message_id, parent_runtime_run_id, parent_tool_call_id, persona_id)
      VALUES ('owner-root', 'root', 'child', 'host', 'turn', 'parent-run', 'call', 'explore');
      INSERT INTO brainstrike_assistant_run_usage
      (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind, delegation_parent_run_id, delegation_tool_call_id)
      VALUES ('usage', 'root', 'host', 'owner-root', 'test', 'openai', 10, 5, 'subagent', 'parent-run', 'call');`);
    await deleteBranch('child');
    expect(
      (
        await database.query(`SELECT input_tokens, output_tokens, delegation_parent_run_id, delegation_tool_call_id
      FROM brainstrike_assistant_run_usage`)
      ).rows
    ).toEqual([
      {
        delegation_parent_run_id: null,
        delegation_tool_call_id: null,
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

  it('rejects the whole deletion if a descendant native scope changed', async () => {
    await database.query(
      `UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'grandchild'`
    );
    await expect(deleteBranch('child')).rejects.toThrow();
    expect((await database.query('SELECT id FROM mastra_threads')).rows).toHaveLength(5);
    expect((await database.query('SELECT seq FROM brainstrike_mind_ops')).rows).toEqual([]);
  });

  it('rejects deleting a child through an ancestor whose ownership changed', async () => {
    await database.query(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'root'`);
    await expect(deleteBranch('child')).rejects.toThrow();
    expect((await database.query('SELECT id FROM mastra_threads')).rows).toHaveLength(5);
    expect((await database.query('SELECT seq FROM brainstrike_mind_ops')).rows).toEqual([]);
  });

  if (mode === 'bulk') {
    it('validates all requested roots before deleting overlapping branches exactly once', async () => {
      const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
      await expect(repository.deleteThreads(['root', 'missing'])).rejects.toThrow();
      expect((await database.query('SELECT id FROM mastra_threads')).rows).toHaveLength(5);
      expect((await database.query('SELECT seq FROM brainstrike_mind_ops')).rows).toEqual([]);
      await repository.deleteThreads(['root', 'child', 'unrelated']);
      expect((await database.query('SELECT id FROM mastra_threads')).rows).toEqual([]);
      expect(
        (await database.query('SELECT entity_id FROM brainstrike_mind_ops')).rows
      ).toHaveLength(5);
    });
  }
});
