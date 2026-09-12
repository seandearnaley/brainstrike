import type { Page } from '@playwright/test';

export interface DelegatedResetSeed {
  readonly childId: string;
  readonly continuationId: string;
  readonly rootId: string;
}

/** Exact migrated relations, deliberately independent of the production reset registry. */
const PROBE_TABLES = [
  ['mastra_threads', 'id', 'threads'],
  ['mastra_messages', 'thread_id', 'threads'],
  ['brainstrike_delegated_conversations', 'root_thread_id', 'root'],
  ['brainstrike_delegated_invocations', 'root_thread_id', 'root'],
  ['brainstrike_delegated_tool_decisions', 'root_thread_id', 'root'],
  ['brainstrike_assistant_thread_runs', 'thread_id', 'root'],
  ['brainstrike_assistant_run_events', 'thread_id', 'root'],
  ['brainstrike_delegation_budgets', 'root_thread_id', 'root'],
  ['brainstrike_delegation_child_budgets', 'root_thread_id', 'root'],
  ['brainstrike_delegation_step_reservations', 'root_thread_id', 'root'],
  ['brainstrike_delegated_continuations', 'root_thread_id', 'root'],
  ['brainstrike_delegated_continuation_decisions', 'continuation_id', 'continuation'],
  ['brainstrike_assistant_run_usage', 'thread_id', 'root'],
  ['brainstrike_assistant_thread_workspaces', 'thread_id', 'root'],
] as const;

export async function readDelegatedResetState(
  page: Page,
  seed: DelegatedResetSeed
): Promise<Record<string, unknown[]>> {
  return await page.evaluate(
    async ({ tables, seed }) => {
      const query = window.electronAPI?.db?.query;
      if (!query) {
        throw new Error('Native database bridge unavailable');
      }
      const keys = {
        continuation: [seed.continuationId],
        root: [seed.rootId],
        threads: [seed.rootId, seed.childId],
      };
      const state: Record<string, unknown[]> = {};
      for (const [table, column, key] of tables) {
        const result = await query(
          `SELECT to_jsonb(probe) AS row FROM ${table} probe WHERE ${column} = ANY($1::text[]) ORDER BY to_jsonb(probe)::text`,
          [keys[key]]
        );
        state[table] = result.rows.map((row) => {
          if (!(row && typeof row === 'object' && 'row' in row)) {
            throw new Error(`Malformed reset probe row from ${table}`);
          }
          return row.row;
        });
      }
      return state;
    },
    { seed, tables: PROBE_TABLES }
  );
}

/** Persistence fixture only: no fabricated live native execution or schema DDL. */
export async function seedDelegatedResetState(page: Page): Promise<DelegatedResetSeed> {
  return await page.evaluate(async () => {
    const query = window.electronAPI?.db?.query;
    if (!query) {
      throw new Error('Native database bridge unavailable');
    }
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const owner = 'brainstrike:workspace';
    const childResource = `reset-child:${childId}`;
    const hostRun = crypto.randomUUID();
    const continuation = crypto.randomUUID();
    for (const [id, resource, title] of [
      [rootId, owner, 'Delegated reset root'],
      [childId, childResource, 'Reset Cedar'],
    ]) {
      await query(
        `INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt", metadata)
        VALUES ($1, $2, $3, NOW(), NOW(), '{}'::jsonb)`,
        [id, resource, title]
      );
    }
    await query(
      `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
      VALUES ($1, $2, $3::jsonb, 'assistant', 'v2', NOW(), $4)`,
      [
        crypto.randomUUID(),
        childId,
        JSON.stringify({
          content: 'Reset child durable evidence',
          format: 2,
          parts: [{ text: 'Reset child durable evidence', type: 'text' }],
        }),
        childResource,
      ]
    );
    await query(
      `INSERT INTO brainstrike_delegated_conversations (thread_id, owner_resource_id, root_thread_id, resource_id)
      VALUES ($1, $2, $1, $2)`,
      [rootId, owner]
    );
    await query(
      `INSERT INTO brainstrike_delegated_conversations (thread_id, owner_resource_id, root_thread_id, parent_thread_id, resource_id, configuration, display_name, color)
      VALUES ($1, $2, $3, $3, $4, '{}'::jsonb, 'Reset Cedar', 'emerald')`,
      [childId, owner, rootId, childResource]
    );
    await query(
      `INSERT INTO brainstrike_assistant_thread_runs (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, completed_at, created_at, updated_at, turn_message_id)
      VALUES ($1, $2, $3, 'openrouter', 'openai/gpt-5.4', 'local', 'completed', NOW(), NOW(), NOW(), NOW(), 'reset-turn')`,
      [hostRun, owner, rootId]
    );
    await query(
      `INSERT INTO brainstrike_assistant_run_events (id, run_id, resource_id, thread_id, sequence, kind, status, label, occurred_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 1, 'tool.completed', 'completed', 'Reset evidence', NOW(), NOW(), NOW())`,
      [crypto.randomUUID(), hostRun, owner, rootId]
    );
    await query(
      `INSERT INTO brainstrike_delegated_invocations (owner_resource_id, root_thread_id, thread_id, host_run_id, turn_message_id, parent_runtime_run_id, parent_tool_call_id, persona_id, child_runtime_run_id)
      VALUES ($1, $2, $3, $4, 'reset-turn', 'reset-parent-runtime', 'reset-delegation-call', 'worker', 'reset-child-runtime')`,
      [owner, rootId, childId, hostRun]
    );
    await query(
      `INSERT INTO brainstrike_delegated_tool_decisions (id, owner_resource_id, root_thread_id, parent_runtime_run_id, parent_tool_call_id, child_thread_id, child_runtime_run_id, tool_call_id, host_run_id, state)
      VALUES ($1, $2, $3, 'reset-parent-runtime', 'reset-delegation-call', $4, 'reset-child-runtime', 'reset-child-tool', $5, 'consumed')`,
      [crypto.randomUUID(), owner, rootId, childId, hostRun]
    );
    await query(
      `INSERT INTO brainstrike_delegation_budgets (root_thread_id, turn_message_id, owner_resource_id, max_depth, max_invocations, max_output_tokens, charged_output_tokens, max_child_steps, max_child_output_tokens, max_step_output_tokens, synthesis_output_tokens, invocations)
      VALUES ($1, 'reset-turn', $2, 3, 4, 100, 7, 4, 30, 10, 10, 1)`,
      [rootId, owner]
    );
    await query(
      `INSERT INTO brainstrike_delegation_child_budgets (root_thread_id, turn_message_id, child_thread_id, max_steps, steps, charged_output_tokens)
      VALUES ($1, 'reset-turn', $2, 4, 1, 7)`,
      [rootId, childId]
    );
    await query(
      `INSERT INTO brainstrike_delegation_step_reservations (id, root_thread_id, turn_message_id, child_thread_id, host_run_id, output_tokens, settled)
      VALUES ($1, $2, 'reset-turn', $3, $4, 7, true)`,
      [crypto.randomUUID(), rootId, childId, hostRun]
    );
    await query(
      `INSERT INTO brainstrike_delegated_continuations (id, owner_resource_id, root_thread_id, thread_id, host_run_id, active_host_run_id, turn_message_id, input_text, native_run_id, state)
      VALUES ($1, $2, $3, $4, $5, $5, 'reset-continuation-turn', 'Reset continuation evidence', 'reset-continuation-native', 'completed')`,
      [continuation, owner, rootId, childId, hostRun]
    );
    await query(
      `INSERT INTO brainstrike_delegated_continuation_decisions (continuation_id, native_run_id, target_runtime_run_id, tool_call_id, kind, host_run_id, previous_host_run_id, state)
      VALUES ($1, 'reset-continuation-native', 'reset-continuation-native', 'reset-continuation-tool', 'tool-approval', $2, $2, 'consumed')`,
      [continuation, hostRun]
    );
    await query(
      `INSERT INTO brainstrike_assistant_run_usage (id, thread_id, run_id, resource_id, model, provider, run_kind, input_tokens, output_tokens, continuation_id)
      VALUES ($1, $2, 'reset-continuation-native', $3, 'openai/gpt-5.4', 'openrouter', 'subagent', 11, 7, $4)`,
      [crypto.randomUUID(), rootId, owner, continuation]
    );
    const appId = `delegated-conversation:${encodeURIComponent(JSON.stringify([owner, rootId, childId]))}`;
    const workspace = {
      apps: { openAppIds: [appId], selection: { appId, kind: 'app' } },
      editors: {},
      explorer: { byRoot: {} },
      fileTabs: { activeTabId: null, tabs: [] },
      roots: { focusedRootId: null, visibleRootIds: null },
      version: 1,
    };
    await query(
      `INSERT INTO brainstrike_assistant_thread_workspaces (thread_id, resource_id, payload)
      VALUES ($1, $2, $3::jsonb)`,
      [rootId, owner, JSON.stringify(workspace)]
    );
    return { childId, continuationId: continuation, rootId };
  });
}
