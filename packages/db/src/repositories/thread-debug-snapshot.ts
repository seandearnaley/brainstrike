import { AUTHORIZED_DELEGATED_GRAPH } from './delegated-graph-sql.js';
import type { DiagnosticEventsDatabase } from './diagnostic-events-repository.js';

export interface ThreadDebugSnapshot {
  readonly capturedAt: string;
  readonly rootThreadId: string;
  readonly sections: Record<string, Record<string, unknown>[]>;
  readonly threadId: string;
}

// This explicit inventory is the export contract, not general database access.
// Each subquery shares one PostgreSQL statement snapshot, including active runs.
const SECTIONS = {
  childBudgets:
    'SELECT b.* FROM brainstrike_delegation_child_budgets b JOIN subtree s ON s.thread_id = b.child_thread_id ORDER BY b.root_thread_id, b.turn_message_id, b.child_thread_id',
  continuationDecisions:
    'SELECT d.* FROM brainstrike_delegated_continuation_decisions d JOIN brainstrike_delegated_continuations c ON c.id = d.continuation_id JOIN subtree s ON s.thread_id = c.thread_id ORDER BY d.created_at, d.continuation_id, d.target_runtime_run_id, d.tool_call_id',
  continuations:
    'SELECT c.* FROM brainstrike_delegated_continuations c JOIN subtree s USING (thread_id) ORDER BY c.created_at, c.id',
  conversations:
    'SELECT n.* FROM owned_nodes n JOIN subtree s USING (thread_id) ORDER BY delegation_depth, thread_id',
  decisions:
    'SELECT d.* FROM brainstrike_delegated_tool_decisions d WHERE d.child_thread_id IN (SELECT thread_id FROM subtree) ORDER BY d.created_at, d.id',
  delegationBudgets: `SELECT b.* FROM brainstrike_delegation_budgets b WHERE b.root_thread_id IN (SELECT thread_id FROM subtree)
    OR EXISTS (SELECT 1 FROM brainstrike_delegation_child_budgets c JOIN subtree s ON s.thread_id = c.child_thread_id
      WHERE c.root_thread_id = b.root_thread_id AND c.turn_message_id = b.turn_message_id) ORDER BY b.root_thread_id, b.turn_message_id`,
  diagnostics:
    'SELECT d.* FROM brainstrike_diagnostic_events d WHERE d.thread_id IN (SELECT thread_id FROM subtree) OR d.run_id IN (SELECT id FROM brainstrike_assistant_thread_runs WHERE thread_id IN (SELECT thread_id FROM subtree)) ORDER BY d.occurred_at, d.id',
  errors:
    'SELECT e.* FROM brainstrike_assistant_run_errors e JOIN subtree s USING (thread_id) ORDER BY e.occurred_at, e.run_id',
  events:
    'SELECT e.* FROM brainstrike_assistant_run_events e JOIN subtree s USING (thread_id) ORDER BY e.occurred_at, e.run_id, e.sequence, e.id',
  invocations:
    'SELECT i.* FROM brainstrike_delegated_invocations i JOIN subtree s USING (thread_id) ORDER BY i.created_at, i.parent_runtime_run_id, i.parent_tool_call_id',
  messageParents:
    'SELECT p.* FROM brainstrike_assistant_message_parents p JOIN subtree s USING (thread_id) ORDER BY p.message_id',
  messages:
    'SELECT m.* FROM mastra_messages m JOIN subtree s USING (thread_id) ORDER BY m."createdAt", m.id',
  outcomes:
    'SELECT o.* FROM brainstrike_assistant_run_outcomes o JOIN subtree s USING (thread_id) ORDER BY o.labeled_at, o.run_id',
  runs: 'SELECT r.* FROM brainstrike_assistant_thread_runs r JOIN subtree s USING (thread_id) ORDER BY r.started_at, r.id',
  stepReservations:
    'SELECT r.* FROM brainstrike_delegation_step_reservations r JOIN subtree s ON s.thread_id = r.child_thread_id ORDER BY r.id',
  threads:
    'SELECT t.* FROM mastra_threads t JOIN subtree s ON s.thread_id = t.id ORDER BY t."createdAt", t.id',
  toolOutputs: `SELECT a.id, a.resource_id, a.thread_id, a.execution_thread_id, a.run_id, a.tool_call_id,
    a.format, encode(a.content, 'base64') AS "contentBase64", a.byte_length, a.created_at, a.expires_at
    FROM brainstrike_assistant_tool_output_artifacts a JOIN subtree s ON s.thread_id = a.execution_thread_id
    ORDER BY a.created_at, a.id`,
  toolProjections:
    'SELECT p.* FROM brainstrike_assistant_tool_projection_rewrites p JOIN subtree s USING (thread_id) ORDER BY p.created_at, p.tool_call_id',
  toolTelemetry:
    'SELECT t.* FROM brainstrike_tool_call_telemetry t JOIN subtree s USING (thread_id) ORDER BY t.occurred_at, t.id',
  treatments:
    'SELECT t.* FROM brainstrike_assistant_run_treatments t JOIN subtree s USING (thread_id) ORDER BY t.created_at, t.run_id',
  usage: `SELECT u.* FROM brainstrike_assistant_run_usage u
    WHERE u.thread_id IN (SELECT thread_id FROM subtree)
      OR EXISTS (SELECT 1 FROM brainstrike_delegated_invocations i JOIN subtree s USING (thread_id)
        WHERE i.root_thread_id = u.thread_id AND i.parent_runtime_run_id = u.delegation_parent_run_id
          AND i.parent_tool_call_id = u.delegation_tool_call_id)
      OR EXISTS (SELECT 1 FROM brainstrike_delegated_continuations c JOIN subtree s USING (thread_id)
        WHERE c.id = u.continuation_id)
    ORDER BY u.created_at, u.id`,
} as const;

const SNAPSHOT_SQL = `${AUTHORIZED_DELEGATED_GRAPH},
  available AS (
    SELECT thread_id, parent_thread_id FROM owned_nodes
    UNION ALL
    SELECT id, NULL::text FROM mastra_threads
    WHERE id = $2 AND "resourceId" = $1
      AND NOT EXISTS (SELECT 1 FROM brainstrike_delegated_conversations WHERE thread_id = $2)
  ),
  subtree AS (
    SELECT * FROM available WHERE thread_id = $3
    UNION
    SELECT n.* FROM available n JOIN subtree p ON n.parent_thread_id = p.thread_id
  )
  SELECT statement_timestamp()::text AS "capturedAt", jsonb_build_object(
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
 * boundary. Resolve the selected native thread, then revalidate its entire
 * ancestry through the same graph as ordinary child history reads. */
export async function readThreadDebugSnapshot(
  db: DiagnosticEventsDatabase,
  threadId: string
): Promise<ThreadDebugSnapshot> {
  const identity = await db.query(
    `SELECT COALESCE(n.root_thread_id, t.id) AS "rootThreadId",
    COALESCE(n.owner_resource_id, t."resourceId") AS "ownerResourceId"
    FROM mastra_threads t LEFT JOIN brainstrike_delegated_conversations n ON n.thread_id = t.id
    WHERE t.id = $1`,
    [threadId]
  );
  const scope = identity.rows[0];
  if (
    !isRecord(scope) ||
    typeof scope['rootThreadId'] !== 'string' ||
    typeof scope['ownerResourceId'] !== 'string'
  ) {
    throw new Error('Thread debug pack unavailable: the conversation no longer exists.');
  }
  const result = await db.query(SNAPSHOT_SQL, [
    scope['ownerResourceId'],
    scope['rootThreadId'],
    threadId,
  ]);
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
