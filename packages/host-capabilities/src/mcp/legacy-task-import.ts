import type {
  McpTaskLegacyAuthorityWire,
  McpTaskLegacyTaskWire,
  StateStore,
} from '@brainstrike/state-store';
import { z } from 'zod';

const Timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const Status = z.enum(['cancelled', 'completed', 'failed', 'input_required', 'working']);
const JsonObject = z.record(z.string(), z.json());
const json = (value: unknown): string => JSON.stringify(value);
const jsonOrNull = (value: unknown): string | null => (value === null ? null : json(value));

// biome-ignore-start lint/style/useNamingConvention: the PGlite Tasks tables' column names.
const Scope = {
  authority_epoch: z.uuid(),
  principal_id: z.string(),
  resource: z.string(),
  server_id: z.string(),
};

const AuthorityRow = z
  .strictObject({
    ...Scope,
    connection_generation: z.number().int().nonnegative(),
    created_at: Timestamp,
    retired_at: Timestamp.nullable(),
    runtime_id: z.string(),
    updated_at: Timestamp,
  })
  .transform(
    (row): McpTaskLegacyAuthorityWire => ({
      authorityEpoch: row.authority_epoch,
      connectionGeneration: row.connection_generation,
      createdAt: row.created_at,
      principalId: row.principal_id,
      resource: row.resource,
      retiredAt: row.retired_at,
      runtimeId: row.runtime_id,
      serverId: row.server_id,
      updatedAt: row.updated_at,
    })
  );

const TaskRow = z
  .strictObject({
    ...Scope,
    blocked_diagnostic: JsonObject.nullable(),
    created_at: Timestamp,
    history: z.array(z.strictObject({ at: Timestamp, status: Status })),
    input_metadata: JsonObject.nullable(),
    result_metadata: JsonObject.nullable(),
    status: Status,
    status_message: z.string().nullable(),
    task_id: z.string(),
    terminal_at: Timestamp.nullable(),
    updated_at: Timestamp,
  })
  .transform(
    (row): McpTaskLegacyTaskWire => ({
      authorityEpoch: row.authority_epoch,
      blockedDiagnostic: jsonOrNull(row.blocked_diagnostic),
      createdAt: row.created_at,
      history: json(row.history),
      inputMetadata: jsonOrNull(row.input_metadata),
      principalId: row.principal_id,
      resource: row.resource,
      resultMetadata: jsonOrNull(row.result_metadata),
      serverId: row.server_id,
      status: row.status,
      statusMessage: row.status_message,
      taskId: row.task_id,
      terminalAt: row.terminal_at,
      updatedAt: row.updated_at,
    })
  );
// biome-ignore-end lint/style/useNamingConvention: the PGlite Tasks tables' column names.

/** The desktop's PGlite Tasks rows as Main reads them (`readPgliteMcpTaskRows`). */
export const LegacyMcpTaskRowsSchema = z.strictObject({
  authorities: z.array(AuthorityRow),
  tasks: z.array(TaskRow),
});

/**
 * Import the desktop's PGlite Tasks rows into the host StateStore once
 * (BST-1930 ruling B). The StateStore's completion marker decides: once it is
 * written, Main is never asked again. Rows, marker and authority retirement
 * commit in one transaction, and the StateStore's CHECKs refuse an invalid row
 * loudly, so a failure leaves nothing behind and the next open retries.
 */
export async function importLegacyMcpTasks(
  store: Pick<StateStore, 'mcpTasks'>,
  readLegacyRows: () => Promise<unknown>,
  now: () => Date = () => new Date()
): Promise<void> {
  const status = await store.mcpTasks({ operation: 'legacy-import-status' });
  if (status.rows.length > 0) {
    return;
  }
  const rows = LegacyMcpTaskRowsSchema.parse(await readLegacyRows());
  await store.mcpTasks({
    at: now().toISOString(),
    authorities: rows.authorities,
    operation: 'legacy-import',
    tasks: rows.tasks,
  });
}
