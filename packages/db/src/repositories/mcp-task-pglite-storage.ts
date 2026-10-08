import type {
  McpTaskAuthorityInput,
  McpTaskAuthorityLease,
  McpTaskDatabase,
  McpTaskIdentity,
  McpTaskInsert,
  McpTaskPatch,
  McpTaskStorage,
} from './mcp-task-repository.js';

const TABLE = 'brainstrike_mcp_tasks';
const AUTHORITY_TABLE = 'brainstrike_mcp_task_authorities';

function identityParams(identity: McpTaskIdentity): unknown[] {
  return [
    identity.authorityEpoch,
    identity.serverId,
    identity.resource,
    identity.principalId,
    identity.taskId,
  ];
}

function leaseParams(lease: McpTaskAuthorityLease): unknown[] {
  return [
    lease.authorityEpoch,
    lease.serverId,
    lease.resource,
    lease.principalId,
    lease.runtimeId,
    lease.connectionGeneration,
  ];
}

/** The PGlite Tasks tables (migrations 114/115); PostgreSQL mints each authority epoch. */
export function pgliteMcpTaskStorage(db: McpTaskDatabase): McpTaskStorage {
  return {
    async get(identity: McpTaskIdentity): Promise<unknown> {
      const result = await db.query(
        `SELECT * FROM ${TABLE}
         WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
           AND principal_id = $4 AND task_id = $5`,
        identityParams(identity)
      );
      return result.rows[0];
    },

    async insert(row: McpTaskInsert, lease: McpTaskAuthorityLease): Promise<unknown> {
      if (row.threadId !== null) {
        throw new Error('The PGlite MCP Tasks table has no thread association.');
      }
      const result = await db.query(
        `INSERT INTO ${TABLE} (
           authority_epoch, server_id, resource, principal_id, task_id, status,
           status_message, input_metadata, result_metadata, blocked_diagnostic,
           history, created_at, updated_at, terminal_at
         )
         SELECT $1::uuid, $2::text, $3::text, $4::text, $7::text, $8::text,
                $9::text, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
                $14::timestamptz, $14::timestamptz, $15::timestamptz
         WHERE EXISTS (
           SELECT 1 FROM ${AUTHORITY_TABLE}
           WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
             AND principal_id = $4 AND runtime_id = $5
             AND connection_generation = $6::bigint AND retired_at IS NULL
         )
         RETURNING *`,
        [
          ...leaseParams(lease),
          row.taskId,
          row.status,
          row.statusMessage,
          row.inputMetadata,
          row.resultMetadata,
          row.blockedDiagnostic,
          row.history,
          row.at,
          row.terminalAt,
        ]
      );
      return result.rows[0];
    },

    async listActive(lease: McpTaskAuthorityLease, limit: number): Promise<readonly unknown[]> {
      const result = await db.query(
        `SELECT * FROM ${TABLE}
         WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
           AND principal_id = $4 AND terminal_at IS NULL
           AND EXISTS (
             SELECT 1 FROM ${AUTHORITY_TABLE}
             WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
               AND principal_id = $4 AND runtime_id = $5
               AND connection_generation = $6::bigint AND retired_at IS NULL
           )
         ORDER BY created_at ASC, task_id ASC
         LIMIT $7`,
        [...leaseParams(lease), limit]
      );
      return result.rows;
    },

    // PostgreSQL measures the normalized `jsonb::text` the CHECK constraint bounds.
    async measureMetadata(
      inputMetadata: string | null,
      resultMetadata: string | null,
      maxBytes: number
    ): Promise<unknown> {
      const result = await db.query(
        `SELECT octet_length(COALESCE($1::jsonb::text, '')) AS "inputBytes",
                CASE WHEN octet_length(COALESCE($1::jsonb::text, '')) > $3::int
                     THEN encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex')
                END AS "inputSha256",
                octet_length(COALESCE($2::jsonb::text, '')) AS "resultBytes",
                CASE WHEN octet_length(COALESCE($2::jsonb::text, '')) > $3::int
                     THEN encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex')
                END AS "resultSha256"`,
        [inputMetadata, resultMetadata, maxBytes]
      );
      return result.rows[0];
    },
    async openAuthority(input: McpTaskAuthorityInput, at: string): Promise<readonly unknown[]> {
      const result = await db.query(
        `WITH live AS (
           SELECT * FROM ${AUTHORITY_TABLE}
           WHERE server_id = $1 AND resource = $2 AND principal_id = $3
             AND retired_at IS NULL
           FOR UPDATE
         ), retired AS (
           UPDATE ${AUTHORITY_TABLE} AS authority
           SET retired_at = GREATEST(authority.updated_at, $6::timestamptz),
               updated_at = GREATEST(authority.updated_at, $6::timestamptz)
           FROM live
           WHERE authority.authority_epoch = live.authority_epoch
             AND live.runtime_id = $4
             AND live.connection_generation < $5::bigint
           RETURNING authority.authority_epoch
         ), rebound AS (
           UPDATE ${AUTHORITY_TABLE} AS authority
           SET runtime_id = $4,
               connection_generation = $5::bigint,
               updated_at = GREATEST(authority.updated_at, $6::timestamptz)
           FROM live
           WHERE authority.authority_epoch = live.authority_epoch
             AND (
               live.runtime_id <> $4 OR live.connection_generation = $5::bigint
             )
             AND NOT EXISTS (
               SELECT 1 FROM retired WHERE retired.authority_epoch = live.authority_epoch
             )
           RETURNING authority.*
         ), created AS (
           INSERT INTO ${AUTHORITY_TABLE} (
             server_id, resource, principal_id, runtime_id, connection_generation,
             created_at, updated_at
           )
           SELECT $1, $2, $3, $4, $5::bigint, $6::timestamptz, $6::timestamptz
           WHERE NOT EXISTS (SELECT 1 FROM live) OR EXISTS (SELECT 1 FROM retired)
           RETURNING *
         )
         SELECT * FROM rebound
         UNION ALL
         SELECT * FROM created`,
        [
          input.serverId,
          input.resource,
          input.principalId,
          input.runtimeId,
          input.connectionGeneration,
          at,
        ]
      );
      return result.rows;
    },

    async retireAuthority(lease: McpTaskAuthorityLease, at: string): Promise<void> {
      await db.query(
        `UPDATE ${AUTHORITY_TABLE}
         SET retired_at = GREATEST(updated_at, $7::timestamptz),
             updated_at = GREATEST(updated_at, $7::timestamptz)
         WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
           AND principal_id = $4 AND runtime_id = $5
           AND connection_generation = $6::bigint AND retired_at IS NULL`,
        [...leaseParams(lease), at]
      );
    },

    async update(
      identity: McpTaskIdentity,
      patch: McpTaskPatch,
      lease: McpTaskAuthorityLease
    ): Promise<unknown> {
      const result = await db.query(
        `UPDATE ${TABLE}
         SET status = $8,
             status_message = CASE WHEN $9 THEN $10 ELSE status_message END,
             input_metadata = CASE WHEN $11 THEN $12::jsonb ELSE input_metadata END,
             result_metadata = CASE WHEN $13 THEN $14::jsonb ELSE result_metadata END,
             blocked_diagnostic = CASE WHEN $15 THEN $16::jsonb ELSE blocked_diagnostic END,
             history = (CASE WHEN jsonb_array_length(history) = 32 THEN history - 0 ELSE history END)
                       || $17::jsonb,
             updated_at = $18::timestamptz,
             terminal_at = CASE WHEN $19 THEN $18::timestamptz ELSE NULL END
         WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
           AND principal_id = $4 AND task_id = $7::text AND terminal_at IS NULL
           AND EXISTS (
             SELECT 1 FROM ${AUTHORITY_TABLE}
             WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
               AND principal_id = $4 AND runtime_id = $5
               AND connection_generation = $6::bigint AND retired_at IS NULL
           )
           AND ($8 <> 'input_required' OR
                (CASE WHEN $11 THEN $12::jsonb ELSE input_metadata END) IS NOT NULL)
           AND ($8 NOT IN ('completed', 'failed') OR
                (CASE WHEN $13 THEN $14::jsonb ELSE result_metadata END) IS NOT NULL)
         RETURNING *`,
        [
          ...leaseParams(lease),
          identity.taskId,
          patch.status,
          patch.hasMessage,
          patch.statusMessage,
          patch.hasInput,
          patch.inputMetadata,
          patch.hasResult,
          patch.resultMetadata,
          patch.hasBlocked,
          patch.blockedDiagnostic,
          patch.historyEntry,
          patch.at,
          patch.terminal,
        ]
      );
      return result.rows[0];
    },
  };
}
