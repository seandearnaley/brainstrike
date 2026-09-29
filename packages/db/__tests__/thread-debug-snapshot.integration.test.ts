import { MASTRA_MEMORY_SCHEMA_SQL } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { createDelegatedConversationRepository } from '../src/repositories/delegated-conversation-repository.js';
import { readThreadDebugSnapshot } from '../src/repositories/thread-debug-snapshot.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir.js';

describe('thread debug snapshot', () => {
  let db: PGlite;
  beforeEach(async () => {
    db = await wasmLoader.createPGlite(createPGliteTestDataDir('thread-debug-snapshot'));
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
    await db.exec(MASTRA_MEMORY_SCHEMA_SQL);
    await db.exec(`INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
      VALUES ('root', 'owner', 'Root', now(), now()), ('other', 'owner', 'Other', now(), now());`);
    const graph = createDelegatedConversationRepository(db);
    const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };
    await graph.registerRoot(scope);
    for (const [threadId, parentThreadId] of [
      ['child', 'root'],
      ['leaf', 'child'],
    ] as const) {
      await db.query(
        `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
        VALUES ($1, $1, $1, now(), now())`,
        [threadId]
      );
      await graph.createChild(scope, {
        color: 'blue',
        configuration: { personaId: 'worker' },
        displayName: threadId,
        parentThreadId,
        resourceId: threadId,
        threadId,
      });
    }
    await db.exec(`INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
      SELECT id || '-run', "resourceId", id, 'openai', 'test-model', 'agent',
        CASE WHEN id = 'child' THEN 'failed' ELSE 'completed' END, now(), now(), now() FROM mastra_threads;
      INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
      SELECT 'message-' || n, 'root', jsonb_build_object('format', 2, 'parts', jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'retained-' || n))),
        'assistant', 'v2', now(), 'owner' FROM generate_series(1, 60) n;
      INSERT INTO brainstrike_assistant_run_events
        (id, run_id, resource_id, thread_id, sequence, kind, status, label, occurred_at, created_at, updated_at)
      SELECT 'event-' || n, 'root-run', 'owner', 'root', n, 'tool.completed', 'completed', 'Tool', now(), now(), now()
      FROM generate_series(1, 600) n;`);
  });
  afterEach(async () => {
    await db.close();
  });

  it('includes successful and failed runs, descendants and all retained rows beyond old caps', async () => {
    const snapshot = await readThreadDebugSnapshot(db, 'root');
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(snapshot.sections['threads']?.map((row) => row['id']).sort()).toEqual([
      'child',
      'leaf',
      'root',
    ]);
    expect(snapshot.sections['runs']).toHaveLength(3);
    expect(snapshot.sections['messages']).toHaveLength(60);
    expect(snapshot.sections['events']).toHaveLength(600);
    expect(snapshot.sections['events']?.at(-1)?.['sequence']).toBe(600);
    expect(JSON.stringify(snapshot)).not.toContain('other-run');
  });

  it('exports only the selected child subtree and rejects invalid ancestry', async () => {
    expect(
      (await readThreadDebugSnapshot(db, 'child')).sections['threads']
        ?.map((row) => row['id'])
        .sort()
    ).toEqual(['child', 'leaf']);
    await db.exec(`UPDATE mastra_threads SET "resourceId" = 'changed' WHERE id = 'child'`);
    expect((await readThreadDebugSnapshot(db, 'root')).sections['threads']).toHaveLength(1);
    await expect(readThreadDebugSnapshot(db, 'leaf')).rejects.toThrow('unavailable');
  });

  it('supports ordinary threads without a delegation graph and rejects missing threads', async () => {
    expect((await readThreadDebugSnapshot(db, 'other')).sections['threads']).toHaveLength(1);
    await expect(readThreadDebugSnapshot(db, 'missing')).rejects.toThrow('has not been saved yet');
  });

  it('retains approval evidence, child continuations, attributed usage and full tool artifacts', async () => {
    await db.exec(`INSERT INTO brainstrike_delegated_invocations
      (owner_resource_id, root_thread_id, thread_id, host_run_id, turn_message_id, parent_runtime_run_id, parent_tool_call_id, persona_id, child_runtime_run_id)
      VALUES ('owner', 'root', 'child', 'root-run', 'message-1', 'native-root', 'delegate-call', 'worker', 'native-child');
      INSERT INTO brainstrike_delegated_tool_decisions
        (id, owner_resource_id, root_thread_id, parent_runtime_run_id, parent_tool_call_id, child_thread_id, child_runtime_run_id, tool_call_id, host_run_id, state)
      VALUES ('decision', 'owner', 'root', 'native-root', 'delegate-call', 'child', 'native-child', 'write-call', 'root-run', 'consumed');
      INSERT INTO brainstrike_delegated_continuations
        (id, owner_resource_id, root_thread_id, thread_id, host_run_id, active_host_run_id, turn_message_id, input_text, state)
      VALUES ('continuation', 'owner', 'root', 'child', 'root-run', 'root-run', 'message-1', 'Continue', 'completed');
      INSERT INTO brainstrike_delegated_continuation_decisions
        (continuation_id, native_run_id, target_runtime_run_id, tool_call_id, kind, host_run_id, previous_host_run_id, state)
      VALUES ('continuation', 'native-continuation', 'native-child', 'resume-call', 'tool-resume', 'root-run', 'root-run', 'consumed');
      INSERT INTO brainstrike_assistant_run_usage
        (id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, run_kind, delegation_parent_run_id, delegation_tool_call_id)
      VALUES ('child-usage', 'root', 'root-run', 'owner', 'test-model', 'openai', 100, 20, 'subagent', 'native-root', 'delegate-call');
      INSERT INTO brainstrike_assistant_run_events
        (id, run_id, resource_id, thread_id, sequence, kind, status, label, metadata, occurred_at, created_at, updated_at)
      VALUES ('approval', 'child-run', 'child', 'child', 1, 'tool.approval.requested', 'running', 'Approve write', '{"toolCallId":"write-call"}', now(), now(), now()),
        ('tool-error', 'child-run', 'child', 'child', 2, 'tool.failed', 'failed', 'Write failed', '{"toolCallId":"write-call"}', now(), now(), now());`);
    const output = `complete output\u0000${'x'.repeat(210_000)}`;
    const bytes = new TextEncoder().encode(output);
    await db.query(
      `INSERT INTO brainstrike_assistant_tool_output_artifacts
      (id, resource_id, thread_id, execution_thread_id, run_id, tool_call_id, format, content, byte_length, created_at, expires_at)
      VALUES ('artifact', 'owner', 'root', 'child', 'native-child', 'write-call', 'text', $1, $2, now(), now() + interval '1 day')`,
      [bytes, bytes.byteLength]
    );
    const rootOutput = new TextEncoder().encode('root output');
    await db.query(
      `INSERT INTO brainstrike_assistant_tool_output_artifacts
      (id, resource_id, thread_id, execution_thread_id, run_id, tool_call_id, format, content, byte_length, created_at, expires_at)
      VALUES ('root-artifact', 'owner', 'root', 'root', 'root-run', 'root-call', 'text', $1, $2, now(), now() + interval '1 day')`,
      [rootOutput, rootOutput.byteLength]
    );
    const snapshot = await readThreadDebugSnapshot(db, 'child');
    expect(snapshot.sections['events']?.map((row) => row['kind'])).toEqual([
      'tool.approval.requested',
      'tool.failed',
    ]);
    expect(snapshot.sections['decisions']?.[0]?.['tool_call_id']).toBe('write-call');
    expect(snapshot.sections['continuationDecisions']?.[0]?.['continuation_id']).toBe(
      'continuation'
    );
    expect(snapshot.sections['usage']?.[0]?.['id']).toBe('child-usage');
    expect(snapshot.sections['toolOutputs']?.[0]?.['byte_length']).toBe(bytes.byteLength);
    expect(atob(String(snapshot.sections['toolOutputs']?.[0]?.['contentBase64']))).toBe(output);
    const rootSnapshot = await readThreadDebugSnapshot(db, 'root');
    expect(rootSnapshot.sections['toolOutputs']?.map((row) => row['id']).sort()).toEqual([
      'artifact',
      'root-artifact',
    ]);
  });

  it('retains swarm diagnostics, joining a child first step to its subtree through the invocation', async () => {
    // Runtime shapes (debug-pack plan, Task 4 deviations): a child-first-step
    // row is named by the DISPATCHING thread, and `native_run_id` /
    // `parent_tool_call_id` are the invocation's `parent_runtime_run_id` /
    // `parent_tool_call_id`. All three tables hang off the ROOT host run.
    await db.exec(`INSERT INTO brainstrike_delegated_invocations
      (owner_resource_id, root_thread_id, thread_id, host_run_id, turn_message_id, parent_runtime_run_id, parent_tool_call_id, persona_id, child_runtime_run_id)
      VALUES ('owner', 'root', 'child', 'root-run', 'message-1', 'native-root', 'delegate-call', 'worker', 'native-child'),
        ('owner', 'root', 'leaf', 'root-run', 'message-1', 'native-child', 'nested-call', 'worker', 'native-leaf');
      INSERT INTO brainstrike_assistant_prompt_manifests
        (id, host_run_id, thread_id, kind, native_run_id, parent_tool_call_id, persona_id, provider, model,
         system_context_source, system_messages, persona_instructions, delegation_prompt, tool_names, total_chars, created_at)
      VALUES
        ('pm-root', 'root-run', 'root', 'root-leg', NULL, NULL, NULL, 'openai', 'test-model', 'captured',
          '[{"role":"system","content":"You are Brainstrike."}]', NULL, NULL, '["brainstrike.grepSearch"]', 20, '2026-09-15T00:00:01Z'),
        ('pm-child', 'root-run', 'root', 'child-first-step', 'native-root', 'delegate-call', 'worker', NULL, NULL, 'root-leg',
          '[]', 'You are the worker.', 'Survey the repo', '["brainstrike.grepSearch"]', 34, '2026-09-15T00:00:02Z'),
        ('pm-leaf', 'root-run', 'child', 'child-first-step', 'native-child', 'nested-call', 'worker', NULL, NULL, 'root-leg',
          '[]', 'You are the worker.', 'Read one file', '[]', 32, '2026-09-15T00:00:03Z'),
        ('pm-continuation', 'root-run', 'child', 'continuation', NULL, NULL, 'worker', NULL, NULL, 'none',
          '[]', NULL, 'Keep going', '["brainstrike.grepSearch"]', 10, '2026-09-15T00:00:04Z'),
        ('pm-child-reentry', 'root-run', 'root', 'child-first-step', 'native-root', 'delegate-call', 'worker', NULL, NULL, 'root-leg',
          '[]', 'You are the worker.', 'Survey the repo', '["brainstrike.grepSearch"]', 34, '2026-09-15T00:00:05Z'),
        ('pm-other', 'other-run', 'other', 'root-leg', NULL, NULL, NULL, 'openai', 'test-model', 'captured',
          '[]', NULL, NULL, '[]', 0, '2026-09-15T00:00:06Z'),
        ('pm-foreign', 'other-run', 'other', 'child-first-step', 'native-root', 'delegate-call', 'worker', NULL, NULL, 'root-leg',
          '[]', 'You are the worker.', 'Same dispatch address under another root', '[]', 26, '2026-09-15T00:00:07Z');
      INSERT INTO brainstrike_delegated_wakeups (id, host_run_id, root_thread_id, kind, directive, invocations)
      VALUES ('wk', 'root-run', 'root', 'idle-loop', 'Background invocation delegate-call (agent-worker) has returned.',
        '[{"taskId":"t1","toolCallId":"delegate-call","toolName":"agent-worker","outcome":"completed"}]');
      INSERT INTO brainstrike_delegated_live_decisions
        (id, host_run_id, root_thread_id, task_id, tool_call_id, delegation_tool_call_id, tool_name, kind, decision,
         source, outcome, answered_sibling_task_ids, policy_snapshot)
      VALUES ('ld', 'root-run', 'root', 't1', 'delegate-call', 'write-call', 'brainstrike.writeWorkspaceFile', 'approval',
        'approve', 'user', 'delivered', '["t2"]', '{"yolo":false}');`);
    const ids = (rows: Record<string, unknown>[] | undefined): unknown[] | undefined =>
      rows?.map((row) => row['id']);

    const root = await readThreadDebugSnapshot(db, 'root');
    expect(ids(root.sections['promptManifests'])).toEqual([
      'pm-root',
      'pm-child',
      'pm-leaf',
      'pm-continuation',
      'pm-child-reentry',
    ]);
    expect(root.sections['promptManifests']?.[0]).toMatchObject({
      system_messages: [{ content: 'You are Brainstrike.', role: 'system' }],
      tool_names: ['brainstrike.grepSearch'],
    });
    expect(root.sections['wakeups']).toEqual([
      expect.objectContaining({
        directive: 'Background invocation delegate-call (agent-worker) has returned.',
        invocations: [
          {
            outcome: 'completed',
            taskId: 't1',
            toolCallId: 'delegate-call',
            toolName: 'agent-worker',
          },
        ],
        kind: 'idle-loop',
      }),
    ]);
    expect(root.sections['liveDecisions']).toEqual([
      expect.objectContaining({
        answered_sibling_task_ids: ['t2'],
        decision: 'approve',
        delegation_tool_call_id: 'write-call',
        outcome: 'delivered',
        policy_snapshot: { yolo: false },
      }),
    ]);
    expect(JSON.stringify(root)).not.toContain('pm-other');

    // The child's own first step is named by the root (dispatching) thread, so
    // only the invocation join brings it into the child's pack.
    const child = await readThreadDebugSnapshot(db, 'child');
    expect(ids(child.sections['promptManifests'])).toEqual([
      'pm-child',
      'pm-leaf',
      'pm-continuation',
      'pm-child-reentry',
    ]);
    // The invocation join is scoped to the manifest's own root: the same
    // dispatch address recorded under another root never joins in.
    expect(JSON.stringify(child)).not.toContain('pm-foreign');
    expect(child.sections['wakeups']).toEqual([]);
    expect(child.sections['liveDecisions']).toEqual([]);
    const leaf = await readThreadDebugSnapshot(db, 'leaf');
    expect(ids(leaf.sections['promptManifests'])).toEqual(['pm-leaf']);
  });
});
