export interface ThreadDebugDatabase {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface ThreadDebugSnapshot {
  readonly capturedAt: string;
  readonly rootThreadId: string;
  readonly sections: Record<string, Record<string, unknown>[]>;
  readonly threadId: string;
}

// This explicit inventory is the export contract, not general database access.
// SNAPSHOT_SQL deliberately composes every subquery into one PostgreSQL statement
// so all sections, including active runs, share the same database snapshot.
const selectColumns = (alias: string, columns: readonly string[]): string =>
  columns.map((column) => `${alias}."${column}"`).join(', ');

const SECTIONS = {
  diagnostics: `SELECT ${selectColumns('d', ['id', 'occurred_at', 'severity', 'source', 'scope', 'code', 'message', 'stack', 'cause_chain', 'context', 'fingerprint', 'session_id', 'run_id', 'thread_id', 'resource_id', 'root_id', 'app_version', 'platform', 'created_at'])}
    FROM brainstrike_diagnostic_events d
    WHERE d.thread_id IN (SELECT thread_id FROM subtree)
      OR d.run_id IN (SELECT id FROM brainstrike_assistant_thread_runs WHERE thread_id IN (SELECT thread_id FROM subtree))
    ORDER BY d.occurred_at, d.id`,
  errors: `SELECT ${selectColumns('e', ['run_id', 'thread_id', 'resource_id', 'code', 'message', 'cause_chain', 'http_status', 'provider_request_id', 'response_headers', 'occurred_at', 'created_at'])}
    FROM brainstrike_assistant_run_errors e JOIN subtree s USING (thread_id)
    ORDER BY e.occurred_at, e.run_id`,
  events: `SELECT ${selectColumns('e', ['id', 'run_id', 'resource_id', 'thread_id', 'sequence', 'kind', 'status', 'label', 'detail', 'duration_ms', 'metadata', 'occurred_at', 'created_at', 'updated_at'])}
    FROM brainstrike_assistant_run_events e JOIN subtree s USING (thread_id)
    ORDER BY e.occurred_at, e.run_id, e.sequence, e.id`,
  messageParents: `SELECT ${selectColumns('p', ['message_id', 'thread_id', 'resource_id', 'parent_id', 'created_at', 'updated_at'])}
    FROM brainstrike_assistant_message_parents p JOIN subtree s USING (thread_id)
    ORDER BY p.message_id`,
  messages: `SELECT ${selectColumns('m', ['id', 'thread_id', 'content', 'role', 'type', 'createdAt', 'resourceId'])}
    FROM mastra_messages m JOIN subtree s USING (thread_id)
    ORDER BY m."createdAt", m.id`,
  outcomes: `SELECT ${selectColumns('o', ['run_id', 'thread_id', 'resource_id', 'verdict', 'source', 'detail', 'labeled_at', 'created_at', 'updated_at'])}
    FROM brainstrike_assistant_run_outcomes o JOIN subtree s USING (thread_id)
    ORDER BY o.labeled_at, o.run_id`,
  promptManifests: `SELECT ${selectColumns('p', ['id', 'host_run_id', 'thread_id', 'kind', 'native_run_id', 'parent_tool_call_id', 'persona_id', 'provider', 'model', 'system_context_source', 'system_messages', 'persona_instructions', 'delegation_prompt', 'tool_names', 'total_chars', 'truncated', 'created_at'])}
    FROM brainstrike_assistant_prompt_manifests p
    JOIN brainstrike_assistant_thread_runs host ON host.id = p.host_run_id
    WHERE p.thread_id IN (SELECT thread_id FROM subtree)
    ORDER BY p.created_at, p.id`,
  runs: `SELECT ${selectColumns('r', ['id', 'resource_id', 'thread_id', 'provider', 'model', 'model_settings', 'provider_options', 'runtime_kind', 'status', 'error', 'started_at', 'completed_at', 'created_at', 'updated_at', 'turn_message_id'])}
    FROM brainstrike_assistant_thread_runs r JOIN subtree s USING (thread_id)
    ORDER BY r.started_at, r.id`,
  threads: `SELECT ${selectColumns('t', ['id', 'resourceId', 'title', 'metadata', 'createdAt', 'updatedAt'])}
    FROM mastra_threads t JOIN subtree s ON s.thread_id = t.id
    ORDER BY t."createdAt", t.id`,
  toolOutputs: `SELECT ${selectColumns('a', ['id', 'resource_id', 'thread_id', 'execution_thread_id', 'run_id', 'tool_call_id', 'format'])},
    encode(a.content, 'base64') AS "contentBase64", ${selectColumns('a', ['byte_length', 'created_at', 'expires_at'])}
    FROM brainstrike_assistant_tool_output_artifacts a JOIN subtree s ON s.thread_id = a.execution_thread_id
    ORDER BY a.created_at, a.id`,
  toolTelemetry: `SELECT ${selectColumns('t', ['id', 'thread_id', 'run_id', 'tool_id', 'occurred_at', 'model_facing_chars', 'truncated', 'zero_match', 'is_pagination_followup', 'engine', 'scan_limited', 'candidates_truncated'])}
    FROM brainstrike_tool_call_telemetry t JOIN subtree s USING (thread_id)
    ORDER BY t.occurred_at, t.id`,
  treatments: `SELECT ${selectColumns('t', ['run_id', 'thread_id', 'resource_id', 'experiment_id', 'variant', 'injection_status', 'signal_injected', 'signal_content_hash', 'created_at'])}
    FROM brainstrike_assistant_run_treatments t JOIN subtree s USING (thread_id)
    ORDER BY t.created_at, t.run_id`,
  usage: `SELECT ${selectColumns('u', ['id', 'thread_id', 'run_id', 'resource_id', 'model', 'provider', 'input_tokens', 'output_tokens', 'created_at', 'root_id', 'billed_cost_usd', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'run_kind'])}
    FROM brainstrike_assistant_run_usage u
    WHERE u.thread_id IN (SELECT thread_id FROM subtree)
    ORDER BY u.created_at, u.id`,
} as const;

const SNAPSHOT_SQL = `WITH subtree AS (
    SELECT id AS thread_id FROM mastra_threads WHERE id = $2 AND "resourceId" = $1
  )
  SELECT to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAt", jsonb_build_object(
    ${Object.entries(SECTIONS)
      .map(
        ([name, sql]) =>
          `'${name}', (SELECT COALESCE(jsonb_agg(row_to_json(row)), '[]'::jsonb) FROM (${sql}) row)`
      )
      .join(',\n')}
  ) AS sections`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Local, user-initiated export only. This is not a remotely callable authority
 * boundary. Resolve the selected web thread and revalidate its resource before
 * exporting ordinary history in one statement snapshot. */
export async function readThreadDebugSnapshot(
  db: ThreadDebugDatabase,
  threadId: string
): Promise<ThreadDebugSnapshot> {
  const identity = await db.query(
    `SELECT id AS "rootThreadId", "resourceId" AS "ownerResourceId"
     FROM mastra_threads WHERE id = $1`,
    [threadId]
  );
  const scope = identity.rows[0];
  if (
    !isRecord(scope) ||
    typeof scope['rootThreadId'] !== 'string' ||
    typeof scope['ownerResourceId'] !== 'string'
  ) {
    throw new Error(
      'Thread debug pack unavailable: the conversation has not been saved yet or no longer exists.'
    );
  }
  const result = await db.query(SNAPSHOT_SQL, [scope['ownerResourceId'], threadId]);
  const row = result.rows[0];
  if (!isRecord(row) || typeof row['capturedAt'] !== 'string' || !isRecord(row['sections'])) {
    throw new Error('Invalid thread debug snapshot.');
  }
  const sections: ThreadDebugSnapshot['sections'] = {};
  for (const name of Object.keys(SECTIONS)) {
    const rows = row['sections'][name];
    if (!(Array.isArray(rows) && rows.every(isRecord))) {
      throw new Error(`Invalid thread debug section: ${name}.`);
    }
    sections[name] = rows;
  }
  if (!sections['threads']?.some((thread) => thread['id'] === threadId)) {
    throw new Error('Thread debug pack unavailable: conversation ownership has changed.');
  }
  return { capturedAt: row['capturedAt'], rootThreadId: scope['rootThreadId'], sections, threadId };
}
