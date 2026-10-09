// @ts-check
// MCP Tasks handles on the existing writer connection (BST-1930 ruling B): the
// SQLite port of the PGlite repository's six statements (migrations 114/115).
// Callers validate every value and row; each operation here is one transaction
// whose checks and writes cannot interleave with another writer.

const TASKS = 'brainstrike_mcp_tasks';
const AUTHORITIES = 'brainstrike_mcp_task_authorities';
const HISTORY_LIMIT = 32;

/** v5: a task row belongs to the host thread whose run created it. */
export const MCP_TASK_THREAD_SCHEMA = `
ALTER TABLE ${TASKS} ADD COLUMN thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE;
CREATE INDEX ${TASKS}_thread_idx ON ${TASKS}(thread_id) WHERE thread_id IS NOT NULL;
`;

/** @typedef {import('./mcp-task-types.js').McpTaskLeaseWire} Lease */
/** @typedef {import('./mcp-task-types.js').McpTaskIdentityWire} Identity */
/** @typedef {import('./mcp-task-types.js').McpTaskDomainRow} Row */

const LIVE_LEASE = `EXISTS (
  SELECT 1 FROM ${AUTHORITIES}
  WHERE authority_epoch = ? AND server_id = ? AND resource = ? AND principal_id = ?
    AND runtime_id = ? AND connection_generation = ? AND retired_at IS NULL
)`;

/** @param {Lease} lease */
function leaseParams(lease) {
  return [
    lease.authorityEpoch,
    lease.serverId,
    lease.resource,
    lease.principalId,
    lease.runtimeId,
    lease.connectionGeneration,
  ];
}

/** @param {Identity} identity */
function identityParams(identity) {
  return [
    identity.authorityEpoch,
    identity.serverId,
    identity.resource,
    identity.principalId,
    identity.taskId,
  ];
}

const JSON_COLUMNS = ['blocked_diagnostic', 'history', 'input_metadata', 'result_metadata'];

/** JSON columns as values, in the PostgreSQL row shape the caller decodes. @param {Record<string, unknown>} row @returns {Row} */
function taskRow(row) {
  /** @type {Record<string, unknown>} */
  const decoded = { ...row };
  for (const column of JSON_COLUMNS) {
    const text = decoded[column];
    decoded[column] = typeof text === 'string' ? JSON.parse(text) : text;
  }
  return decoded;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Lease} lease
 */
function leaseIsLive(db, lease) {
  return (
    db
      .prepare(`SELECT ${LIVE_LEASE} AS live`)
      .pluck()
      .get(...leaseParams(lease)) === 1
  );
}

/**
 * The live scope authority is rebound when another runtime (or the same
 * generation) claims it, retired and replaced when its own runtime advances a
 * generation, and stale when its own runtime presents an older generation.
 * @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./mcp-task-types.js').McpTaskDomainRequest, { operation: 'open-authority' }>} request
 * @returns {Row[]}
 */
function openAuthority(db, { at, authorityEpoch, input }) {
  const live = /** @type {Record<string, unknown> | undefined} */ (
    db
      .prepare(
        `SELECT * FROM ${AUTHORITIES}
         WHERE server_id = ? AND resource = ? AND principal_id = ? AND retired_at IS NULL`
      )
      .get(input.serverId, input.resource, input.principalId)
  );
  if (live) {
    const sameRuntime = live['runtime_id'] === input.runtimeId;
    const generation = Number(live['connection_generation']);
    if (!sameRuntime || generation === input.connectionGeneration) {
      return [
        /** @type {Row} */ (
          db
            .prepare(
              `UPDATE ${AUTHORITIES}
               SET runtime_id = ?, connection_generation = ?, updated_at = max(updated_at, ?)
               WHERE authority_epoch = ? RETURNING *`
            )
            .get(input.runtimeId, input.connectionGeneration, at, live['authority_epoch'])
        ),
      ];
    }
    if (generation > input.connectionGeneration) {
      return [];
    }
    db.prepare(
      `UPDATE ${AUTHORITIES}
       SET retired_at = max(updated_at, ?), updated_at = max(updated_at, ?)
       WHERE authority_epoch = ?`
    ).run(at, at, live['authority_epoch']);
  }
  return [
    /** @type {Row} */ (
      db
        .prepare(
          `INSERT INTO ${AUTHORITIES} (
             authority_epoch, server_id, resource, principal_id, runtime_id,
             connection_generation, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
        )
        .get(
          authorityEpoch,
          input.serverId,
          input.resource,
          input.principalId,
          input.runtimeId,
          input.connectionGeneration,
          at,
          at
        )
    ),
  ];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./mcp-task-types.js').McpTaskDomainRequest, { operation: 'update' }>} request
 * @returns {Row[]}
 */
function update(db, { identity, lease, patch }) {
  const existing = /** @type {Record<string, unknown> | undefined} */ (
    db
      .prepare(
        `SELECT * FROM ${TASKS}
         WHERE authority_epoch = ? AND server_id = ? AND resource = ? AND principal_id = ?
           AND task_id = ? AND terminal_at IS NULL`
      )
      .get(...identityParams(identity))
  );
  if (!(existing && leaseIsLive(db, lease))) {
    return [];
  }
  const inputMetadata = patch.hasInput ? patch.inputMetadata : existing['input_metadata'];
  const resultMetadata = patch.hasResult ? patch.resultMetadata : existing['result_metadata'];
  if (
    (patch.status === 'input_required' && inputMetadata === null) ||
    ((patch.status === 'completed' || patch.status === 'failed') && resultMetadata === null)
  ) {
    return [];
  }
  const history = JSON.parse(/** @type {string} */ (existing['history']));
  if (history.length === HISTORY_LIMIT) {
    history.shift();
  }
  history.push(...JSON.parse(patch.historyEntry));
  return [
    taskRow(
      /** @type {Record<string, unknown>} */ (
        db
          .prepare(
            `UPDATE ${TASKS}
             SET status = ?, status_message = ?, input_metadata = ?, result_metadata = ?,
                 blocked_diagnostic = ?, history = ?, updated_at = ?, terminal_at = ?
             WHERE authority_epoch = ? AND task_id = ? RETURNING *`
          )
          .get(
            patch.status,
            patch.hasMessage ? patch.statusMessage : existing['status_message'],
            inputMetadata,
            resultMetadata,
            patch.hasBlocked ? patch.blockedDiagnostic : existing['blocked_diagnostic'],
            JSON.stringify(history),
            patch.at,
            patch.terminal ? patch.at : null,
            identity.authorityEpoch,
            identity.taskId
          )
      )
    ),
  ];
}

/** The settings key recording that the desktop's PGlite Tasks rows were imported. */
export const MCP_TASK_LEGACY_IMPORT_KEY = 'mcp-tasks.legacy-import';

/** @param {import('better-sqlite3').Database} db @returns {Row[]} */
function legacyImportStatus(db) {
  const value = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .pluck()
    .get(MCP_TASK_LEGACY_IMPORT_KEY);
  return typeof value === 'string' ? [JSON.parse(value)] : [];
}

/**
 * The desktop's PGlite Tasks rows, imported once with their completion marker in one transaction. Plain inserts keep
 * a CHECK failure loud (OR IGNORE would drop the row silently). A legacy authority whose scope is already live here
 * imports retired, so the host's live authority stays the only one for that scope.
 * @param {import('better-sqlite3').Database} db
 * @param {Extract<import('./mcp-task-types.js').McpTaskDomainRequest, { operation: 'legacy-import' }>} request
 * @returns {Row[]}
 */
function legacyImport(db, { at, authorities, tasks }) {
  if (legacyImportStatus(db).length > 0) {
    return [];
  }
  const insertAuthority = db.prepare(
    `INSERT INTO ${AUTHORITIES} (
       authority_epoch, server_id, resource, principal_id, runtime_id,
       connection_generation, created_at, updated_at, retired_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE
       WHEN ? IS NULL AND EXISTS (
         SELECT 1 FROM ${AUTHORITIES}
         WHERE server_id = ? AND resource = ? AND principal_id = ? AND retired_at IS NULL
       ) THEN ? ELSE ? END)`
  );
  for (const authority of authorities) {
    insertAuthority.run(
      authority.authorityEpoch,
      authority.serverId,
      authority.resource,
      authority.principalId,
      authority.runtimeId,
      authority.connectionGeneration,
      authority.createdAt,
      authority.updatedAt,
      authority.retiredAt,
      authority.serverId,
      authority.resource,
      authority.principalId,
      authority.updatedAt,
      authority.retiredAt
    );
  }
  const insertTask = db.prepare(
    `INSERT INTO ${TASKS} (
       authority_epoch, server_id, resource, principal_id, task_id, status,
       status_message, input_metadata, result_metadata, blocked_diagnostic,
       history, created_at, updated_at, terminal_at, thread_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  );
  for (const task of tasks) {
    insertTask.run(
      ...identityParams(task),
      task.status,
      task.statusMessage,
      task.inputMetadata,
      task.resultMetadata,
      task.blockedDiagnostic,
      task.history,
      task.createdAt,
      task.updatedAt,
      task.terminalAt
    );
  }
  const marker = { at, authorities: authorities.length, tasks: tasks.length };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    MCP_TASK_LEGACY_IMPORT_KEY,
    JSON.stringify(marker)
  );
  return [marker];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./mcp-task-types.js').McpTaskDomainRequest} request
 * @returns {Row[]}
 */
function execute(db, request) {
  switch (request.operation) {
    case 'legacy-import':
      return legacyImport(db, request);
    case 'legacy-import-status':
      return legacyImportStatus(db);
    case 'open-authority':
      return openAuthority(db, request);
    case 'retire-authority':
      db.prepare(
        `UPDATE ${AUTHORITIES}
         SET retired_at = max(updated_at, ?), updated_at = max(updated_at, ?)
         WHERE authority_epoch = ? AND server_id = ? AND resource = ? AND principal_id = ?
           AND runtime_id = ? AND connection_generation = ? AND retired_at IS NULL`
      ).run(request.at, request.at, ...leaseParams(request.lease));
      return [];
    case 'insert': {
      const { lease, row } = request;
      const inserted = /** @type {Record<string, unknown> | undefined} */ (
        db
          .prepare(
            `INSERT INTO ${TASKS} (
               authority_epoch, server_id, resource, principal_id, task_id, status,
               status_message, input_metadata, result_metadata, blocked_diagnostic,
               history, created_at, updated_at, terminal_at, thread_id
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE ${LIVE_LEASE}
             RETURNING *`
          )
          .get(
            lease.authorityEpoch,
            lease.serverId,
            lease.resource,
            lease.principalId,
            row.taskId,
            row.status,
            row.statusMessage,
            row.inputMetadata,
            row.resultMetadata,
            row.blockedDiagnostic,
            row.history,
            row.at,
            row.at,
            row.terminalAt,
            row.threadId,
            ...leaseParams(lease)
          )
      );
      return inserted ? [taskRow(inserted)] : [];
    }
    case 'get': {
      const found = /** @type {Record<string, unknown> | undefined} */ (
        db
          .prepare(
            `SELECT * FROM ${TASKS}
             WHERE authority_epoch = ? AND server_id = ? AND resource = ? AND principal_id = ?
               AND task_id = ?`
          )
          .get(...identityParams(request.identity))
      );
      return found ? [taskRow(found)] : [];
    }
    case 'list-active': {
      const { lease } = request;
      return /** @type {Record<string, unknown>[]} */ (
        db
          .prepare(
            `SELECT * FROM ${TASKS}
             WHERE authority_epoch = ? AND server_id = ? AND resource = ? AND principal_id = ?
               AND terminal_at IS NULL AND ${LIVE_LEASE}
             ORDER BY created_at ASC, task_id ASC
             LIMIT ?`
          )
          .all(
            lease.authorityEpoch,
            lease.serverId,
            lease.resource,
            lease.principalId,
            ...leaseParams(lease),
            request.limit
          )
      ).map(taskRow);
    }
    case 'update':
      return update(db, request);
    default:
      throw new TypeError('Unknown MCP task operation');
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('./mcp-task-types.js').McpTaskDomainRequest} request
 * @returns {import('./mcp-task-types.js').McpTaskDomainReply}
 */
export function executeMcpTaskRequest(db, request) {
  return { rows: db.transaction(() => execute(db, request))() };
}
