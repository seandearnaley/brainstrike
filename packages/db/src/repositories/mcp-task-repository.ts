const TABLE = 'brainstrike_mcp_tasks';
const AUTHORITY_TABLE = 'brainstrike_mcp_task_authorities';
export const MCP_TASK_METADATA_MAX_BYTES = 65_536;
const MAX_BLOCKED_DIAGNOSTIC_BYTES = 4096;
const TEXT_ENCODER = new TextEncoder();
const MCP_TASK_STATUSES = [
  'cancelled',
  'completed',
  'failed',
  'input_required',
  'working',
] as const;
type McpTaskStatus = (typeof MCP_TASK_STATUSES)[number];
const TERMINAL_STATUSES = new Set<McpTaskStatus>(['cancelled', 'completed', 'failed']);
export const MAX_ACTIVE_MCP_TASKS_PER_SCOPE = 256;

type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type { McpTaskStatus };

export interface McpTaskBlockedDiagnostic extends JsonObject {
  readonly actualBytes: number;
  readonly code: 'mcp_task_state_too_large';
  readonly field: 'inputMetadata' | 'resultMetadata';
  readonly maxBytes: number;
  readonly remoteStatus: McpTaskStatus;
  readonly sha256: string;
}

export interface McpTaskAuthorityInput {
  readonly connectionGeneration: number;
  readonly principalId: string;
  readonly resource: string;
  readonly runtimeId: string;
  readonly serverId: string;
}

export interface McpTaskScope {
  readonly authorityEpoch: string;
  readonly principalId: string;
  readonly resource: string;
  readonly serverId: string;
}

export interface McpTaskAuthorityLease extends McpTaskAuthorityInput, McpTaskScope {}

export interface McpTaskIdentity extends McpTaskScope {
  readonly taskId: string;
}

export interface McpTaskRecord extends McpTaskIdentity {
  readonly blockedDiagnostic: McpTaskBlockedDiagnostic | null;
  readonly createdAt: Date;
  readonly history: readonly { readonly at: Date; readonly status: McpTaskStatus }[];
  readonly inputMetadata: JsonObject | null;
  readonly resultMetadata: JsonObject | null;
  readonly status: McpTaskStatus;
  readonly statusMessage: string | null;
  readonly terminalAt: Date | null;
  readonly updatedAt: Date;
}

export interface UpdateMcpTaskInput {
  readonly blockedDiagnostic?: McpTaskBlockedDiagnostic | null;
  readonly inputMetadata?: JsonObject | null;
  readonly resultMetadata?: JsonObject | null;
  readonly status: McpTaskStatus;
  readonly statusMessage?: string | null;
}

export interface CreateMcpTaskInput extends McpTaskIdentity, UpdateMcpTaskInput {}

export interface McpTaskDatabase {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

interface McpTaskRow {
  authority_epoch: unknown;
  blocked_diagnostic: unknown;
  created_at: unknown;
  history: unknown;
  input_metadata: unknown;
  principal_id: unknown;
  resource: unknown;
  result_metadata: unknown;
  server_id: unknown;
  status: unknown;
  status_message: unknown;
  task_id: unknown;
  terminal_at: unknown;
  updated_at: unknown;
}

interface McpTaskAuthorityRow {
  authority_epoch: unknown;
  connection_generation: unknown;
  principal_id: unknown;
  resource: unknown;
  runtime_id: unknown;
  server_id: unknown;
}

export class McpTaskMetadataTooLargeError extends TypeError {
  constructor(
    readonly field: 'inputMetadata' | 'resultMetadata',
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly sha256: string
  ) {
    super(`MCP task ${field} exceeds ${maxBytes} bytes.`);
    this.name = 'McpTaskMetadataTooLargeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    TEXT_ENCODER.encode(value).length > maxBytes
  ) {
    throw new TypeError(`MCP task ${field} must contain 1-${maxBytes} UTF-8 bytes.`);
  }
  return value;
}

function requireIdentity(identity: McpTaskIdentity): void {
  requireScope(identity);
  requireText(identity.taskId, 'taskId', 1024);
}

function requireScope(scope: McpTaskScope): void {
  requireUuid(scope.authorityEpoch, 'authorityEpoch');
  requireAuthorityIdentity(scope);
}

function requireAuthorityIdentity(
  identity: Pick<McpTaskAuthorityInput, 'principalId' | 'resource' | 'serverId'>
): void {
  requireText(identity.serverId, 'serverId', 512);
  const resource = requireText(identity.resource, 'resource', 2048);
  const url = new URL(resource);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.href !== resource ||
    // `url.hash` is '' for a bare trailing '#', which the serializer keeps.
    resource.includes('#') ||
    url.username ||
    url.password
  ) {
    throw new TypeError('MCP task resource must be a canonical HTTP(S) URL without a fragment.');
  }
  requireText(identity.principalId, 'principalId', 512);
}

function requireUuid(value: unknown, field: string): string {
  const text = requireText(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new TypeError(`MCP task ${field} must be a UUIDv7.`);
  }
  return text;
}

function requireStatus(value: unknown): McpTaskStatus {
  if (typeof value !== 'string' || !MCP_TASK_STATUSES.includes(value as McpTaskStatus)) {
    throw new TypeError('MCP task status is invalid.');
  }
  return value as McpTaskStatus;
}

function requireInstant(value: unknown, field: string): Date {
  const instant = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(instant.getTime())) {
    throw new TypeError(`MCP task ${field} must be a valid timestamp.`);
  }
  return instant;
}

function requireJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(requireJsonValue);
  }
  return (
    isRecord(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Object.values(value).every(requireJsonValue)
  );
}

function requireMetadata(value: unknown, field: string): JsonObject | null {
  if (value === null) {
    return null;
  }
  if (!(isRecord(value) && requireJsonValue(value))) {
    throw new TypeError(`MCP task ${field} must be a JSON object or null.`);
  }
  return value;
}

function requireBlockedDiagnostic(value: unknown): McpTaskBlockedDiagnostic | null {
  const diagnostic = requireMetadata(value, 'blockedDiagnostic');
  if (diagnostic === null) {
    return null;
  }
  const expectedKeys = ['actualBytes', 'code', 'field', 'maxBytes', 'remoteStatus', 'sha256'];
  if (Object.keys(diagnostic).sort().join(',') !== expectedKeys.join(',')) {
    throw new TypeError('MCP task blockedDiagnostic fields are invalid.');
  }
  const actualBytes = diagnostic['actualBytes'];
  const field = diagnostic['field'];
  const maxBytes = diagnostic['maxBytes'];
  const sha256 = diagnostic['sha256'];
  if (
    diagnostic['code'] !== 'mcp_task_state_too_large' ||
    // The diagnostic records the budget in force when the row was written, so
    // it validates structurally rather than against today's constant.
    !(Number.isSafeInteger(maxBytes) && Number(maxBytes) > 0) ||
    !(Number.isSafeInteger(actualBytes) && Number(actualBytes) > Number(maxBytes)) ||
    !(field === 'inputMetadata' || field === 'resultMetadata') ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(sha256)
  ) {
    throw new TypeError('MCP task blockedDiagnostic values are invalid.');
  }
  const remoteStatus = requireStatus(diagnostic['remoteStatus']);
  return Object.freeze({
    actualBytes: Number(actualBytes),
    code: 'mcp_task_state_too_large',
    field,
    maxBytes: Number(maxBytes),
    remoteStatus,
    sha256,
  });
}

function requireNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || TEXT_ENCODER.encode(value).length > 4096) {
    throw new TypeError('MCP task statusMessage must contain 0-4096 UTF-8 bytes.');
  }
  return value;
}

function requireAuthorityInput(input: McpTaskAuthorityInput): void {
  requireAuthorityIdentity(input);
  requireText(input.runtimeId, 'runtimeId', 512);
  if (!(Number.isSafeInteger(input.connectionGeneration) && input.connectionGeneration >= 0)) {
    throw new TypeError('MCP task connectionGeneration must be a non-negative safe integer.');
  }
}

function requireAuthorityLease(lease: McpTaskAuthorityLease): void {
  requireAuthorityInput(lease);
  requireScope(lease);
}

function serializeMetadata(value: JsonObject | null): string | null {
  if (value === null) {
    return null;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('MCP task metadata must be JSON serializable.');
  }
  return serialized;
}

function mapRow(value: unknown): McpTaskRecord {
  if (!isRecord(value)) {
    throw new TypeError('MCP task row must be an object.');
  }
  const row = value as unknown as McpTaskRow;
  const status = requireStatus(row.status);
  if (!Array.isArray(row.history) || row.history.length === 0 || row.history.length > 32) {
    throw new TypeError('MCP task history must contain 1-32 entries.');
  }
  const history = row.history.map((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError('MCP task history entry must be an object.');
    }
    return {
      at: requireInstant(entry['at'], 'history.at'),
      status: requireStatus(entry['status']),
    };
  });
  const record: McpTaskRecord = {
    authorityEpoch: requireUuid(row.authority_epoch, 'authorityEpoch'),
    blockedDiagnostic: requireBlockedDiagnostic(row.blocked_diagnostic),
    createdAt: requireInstant(row.created_at, 'createdAt'),
    history,
    inputMetadata: requireMetadata(row.input_metadata, 'inputMetadata'),
    principalId: requireText(row.principal_id, 'principalId', 512),
    resource: requireText(row.resource, 'resource', 2048),
    resultMetadata: requireMetadata(row.result_metadata, 'resultMetadata'),
    serverId: requireText(row.server_id, 'serverId', 512),
    status,
    statusMessage: requireNullableText(row.status_message),
    taskId: requireText(row.task_id, 'taskId', 1024),
    terminalAt: row.terminal_at === null ? null : requireInstant(row.terminal_at, 'terminalAt'),
    updatedAt: requireInstant(row.updated_at, 'updatedAt'),
  };
  requireIdentity(record);
  if (
    record.blockedDiagnostic !== null &&
    record.blockedDiagnostic.remoteStatus !== record.status
  ) {
    throw new TypeError('MCP task blockedDiagnostic remoteStatus must match status.');
  }
  if (
    (TERMINAL_STATUSES.has(status) || record.blockedDiagnostic !== null) !==
    (record.terminalAt !== null)
  ) {
    throw new TypeError('MCP task terminal timestamp is inconsistent with status.');
  }
  assertHistoryConsistency(record);
  return record;
}

function assertHistoryConsistency(record: McpTaskRecord): void {
  let previous = record.createdAt.getTime();
  for (const [index, entry] of record.history.entries()) {
    const current = entry.at.getTime();
    if (current < previous) {
      throw new TypeError('MCP task history timestamps must be monotonic.');
    }
    if (index < record.history.length - 1 && TERMINAL_STATUSES.has(entry.status)) {
      throw new TypeError('MCP task history cannot continue after a terminal status.');
    }
    previous = current;
  }
  const last = record.history.at(-1);
  if (!(last && last.at.getTime() === record.updatedAt.getTime())) {
    throw new TypeError('MCP task history must end at updatedAt.');
  }
  if (last.status !== record.status) {
    throw new TypeError('MCP task history final status must match the current status.');
  }
}

function mapAuthorityRow(value: unknown): McpTaskAuthorityLease {
  if (!isRecord(value)) {
    throw new TypeError('MCP task authority row must be an object.');
  }
  const row = value as unknown as McpTaskAuthorityRow;
  const lease: McpTaskAuthorityLease = {
    authorityEpoch: requireUuid(row.authority_epoch, 'authorityEpoch'),
    connectionGeneration: Number(row.connection_generation),
    principalId: requireText(row.principal_id, 'principalId', 512),
    resource: requireText(row.resource, 'resource', 2048),
    runtimeId: requireText(row.runtime_id, 'runtimeId', 512),
    serverId: requireText(row.server_id, 'serverId', 512),
  };
  requireAuthorityLease(lease);
  return Object.freeze(lease);
}

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

function requireMatchingLease(identity: McpTaskScope, lease: McpTaskAuthorityLease): void {
  requireScope(identity);
  requireAuthorityLease(lease);
  if (
    identity.authorityEpoch !== lease.authorityEpoch ||
    identity.serverId !== lease.serverId ||
    identity.resource !== lease.resource ||
    identity.principalId !== lease.principalId
  ) {
    throw new TypeError('MCP task write authority does not match the task scope.');
  }
}

/**
 * Why an UPDATE matched no row: the SQL predicate refuses a terminal row, an
 * `input_required` transition without merged input metadata, and a
 * `completed`/`failed` transition without merged result metadata, so the
 * caller gets the specific contract error instead of a generic miss.
 */
function explainRejectedUpdate(
  existing: McpTaskRecord | null,
  status: McpTaskStatus,
  merged: {
    hasInput: boolean;
    hasResult: boolean;
    inputMetadata: JsonObject | null;
    resultMetadata: JsonObject | null;
  }
): Error {
  if (existing?.terminalAt) {
    return new Error('A terminal MCP task is immutable.');
  }
  if (existing === null) {
    return new Error('MCP task handle is missing or stale.');
  }
  const inputAfter = merged.hasInput ? merged.inputMetadata : existing.inputMetadata;
  if (status === 'input_required' && inputAfter === null) {
    return new TypeError('An input_required MCP task requires inputMetadata.');
  }
  const resultAfter = merged.hasResult ? merged.resultMetadata : existing.resultMetadata;
  if ((status === 'completed' || status === 'failed') && resultAfter === null) {
    return new TypeError('A completed or failed MCP task requires resultMetadata.');
  }
  return new Error('MCP task handle is missing or stale.');
}

/** Durable local Tasks handle store. Lifecycle polling is deliberately out of scope. */
export class McpTaskRepository {
  constructor(
    private readonly db: McpTaskDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  async openAuthority(input: McpTaskAuthorityInput): Promise<McpTaskAuthorityLease> {
    requireAuthorityInput(input);
    const at = requireInstant(this.now(), 'clock').toISOString();
    const result = await this.db.query(
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
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('MCP task authority acquisition is stale.');
    }
    if (result.rows.length !== 1) {
      throw new Error('MCP task authority acquisition did not produce exactly one lease.');
    }
    return mapAuthorityRow(row);
  }

  async retireAuthority(lease: McpTaskAuthorityLease): Promise<void> {
    requireAuthorityLease(lease);
    const at = requireInstant(this.now(), 'clock').toISOString();
    await this.db.query(
      `UPDATE ${AUTHORITY_TABLE}
       SET retired_at = GREATEST(updated_at, $7::timestamptz),
           updated_at = GREATEST(updated_at, $7::timestamptz)
       WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
         AND principal_id = $4 AND runtime_id = $5
         AND connection_generation = $6::bigint AND retired_at IS NULL`,
      [...leaseParams(lease), at]
    );
  }

  async create(input: CreateMcpTaskInput, lease: McpTaskAuthorityLease): Promise<McpTaskRecord> {
    requireIdentity(input);
    requireMatchingLease(input, lease);
    const status = requireStatus(input.status);
    const inputMetadata = requireMetadata(input.inputMetadata ?? null, 'inputMetadata');
    const resultMetadata = requireMetadata(input.resultMetadata ?? null, 'resultMetadata');
    const blockedDiagnostic = requireBlockedDiagnostic(input.blockedDiagnostic ?? null);
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const blockedDiagnosticJson = serializeMetadata(blockedDiagnostic);
    const statusMessage = requireNullableText(input.statusMessage ?? null);
    if (status === 'input_required' && !inputMetadata) {
      throw new TypeError('An input_required MCP task requires inputMetadata.');
    }
    if ((status === 'completed' || status === 'failed') && !resultMetadata) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    await this.assertMetadataBudgets(inputMetadataJson, resultMetadataJson);
    if (
      blockedDiagnosticJson !== null &&
      TEXT_ENCODER.encode(blockedDiagnosticJson).length > MAX_BLOCKED_DIAGNOSTIC_BYTES
    ) {
      throw new TypeError(
        `MCP task blockedDiagnostic exceeds ${MAX_BLOCKED_DIAGNOSTIC_BYTES} bytes.`
      );
    }
    const at = requireInstant(this.now(), 'clock');
    const result = await this.db.query(
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
        input.taskId,
        status,
        statusMessage,
        inputMetadataJson,
        resultMetadataJson,
        blockedDiagnosticJson,
        JSON.stringify([{ at: at.toISOString(), status }]),
        at.toISOString(),
        TERMINAL_STATUSES.has(status) || blockedDiagnostic !== null ? at.toISOString() : null,
      ]
    );
    if (result.rows[0] === undefined) {
      throw new Error('MCP task handle is missing or stale.');
    }
    return mapRow(result.rows[0]);
  }

  async get(identity: McpTaskIdentity): Promise<McpTaskRecord | null> {
    requireIdentity(identity);
    const result = await this.db.query(
      `SELECT * FROM ${TABLE}
       WHERE authority_epoch = $1::uuid AND server_id = $2 AND resource = $3
         AND principal_id = $4 AND task_id = $5`,
      identityParams(identity)
    );
    return result.rows[0] === undefined ? null : mapRow(result.rows[0]);
  }

  /**
   * Bounded by construction like every other query here: the row count is
   * the number of pollers `recover()` fans out, so it is capped at
   * {@link MAX_ACTIVE_MCP_TASKS_PER_SCOPE} in deterministic
   * `created_at, task_id` order (the partial resume index covers the scope).
   */
  async listActive(
    lease: McpTaskAuthorityLease,
    options: { readonly limit?: number } = {}
  ): Promise<readonly McpTaskRecord[]> {
    const limit = options.limit ?? MAX_ACTIVE_MCP_TASKS_PER_SCOPE;
    if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_ACTIVE_MCP_TASKS_PER_SCOPE)) {
      throw new TypeError(
        `MCP task listActive limit must be an integer from 1 to ${MAX_ACTIVE_MCP_TASKS_PER_SCOPE}.`
      );
    }
    requireAuthorityLease(lease);
    const result = await this.db.query(
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
    return result.rows.map(mapRow);
  }

  async update(
    identity: McpTaskIdentity,
    input: UpdateMcpTaskInput,
    lease: McpTaskAuthorityLease
  ): Promise<McpTaskRecord> {
    requireIdentity(identity);
    requireMatchingLease(identity, lease);
    const status = requireStatus(input.status);
    const hasBlocked = Object.hasOwn(input, 'blockedDiagnostic');
    const hasInput = Object.hasOwn(input, 'inputMetadata');
    const hasResult = Object.hasOwn(input, 'resultMetadata');
    const hasMessage = Object.hasOwn(input, 'statusMessage');
    const inputMetadata = requireMetadata(input.inputMetadata ?? null, 'inputMetadata');
    const resultMetadata = requireMetadata(input.resultMetadata ?? null, 'resultMetadata');
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const statusMessage = requireNullableText(input.statusMessage ?? null);
    const blockedDiagnostic = requireBlockedDiagnostic(input.blockedDiagnostic ?? null);
    const blockedDiagnosticJson = serializeMetadata(blockedDiagnostic);
    const requiresResult = status === 'completed' || status === 'failed';
    if (hasResult && resultMetadata === null && requiresResult) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    await this.assertMetadataBudgets(
      hasInput ? inputMetadataJson : null,
      hasResult ? resultMetadataJson : null
    );
    if (
      blockedDiagnosticJson !== null &&
      TEXT_ENCODER.encode(blockedDiagnosticJson).length > MAX_BLOCKED_DIAGNOSTIC_BYTES
    ) {
      throw new TypeError(
        `MCP task blockedDiagnostic exceeds ${MAX_BLOCKED_DIAGNOSTIC_BYTES} bytes.`
      );
    }
    const at = requireInstant(this.now(), 'clock');
    const result = await this.db.query(
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
        status,
        hasMessage,
        statusMessage,
        hasInput,
        inputMetadataJson,
        hasResult,
        resultMetadataJson,
        hasBlocked,
        blockedDiagnosticJson,
        JSON.stringify([{ at: at.toISOString(), status }]),
        at.toISOString(),
        TERMINAL_STATUSES.has(status) || blockedDiagnostic !== null,
      ]
    );
    if (result.rows[0] !== undefined) {
      return mapRow(result.rows[0]);
    }
    throw explainRejectedUpdate(await this.get(identity), status, {
      hasInput,
      hasResult,
      inputMetadata,
      resultMetadata,
    });
  }

  private async assertMetadataBudgets(
    inputMetadataJson: string | null,
    resultMetadataJson: string | null
  ): Promise<void> {
    if (inputMetadataJson === null && resultMetadataJson === null) {
      return;
    }
    // The digest is only read on the over-budget branch, so it is only hashed there.
    const result = await this.db.query(
      `SELECT octet_length(COALESCE($1::jsonb::text, '')) AS input_bytes,
              CASE WHEN octet_length(COALESCE($1::jsonb::text, '')) > $3::int
                   THEN encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex')
              END AS input_sha256,
              octet_length(COALESCE($2::jsonb::text, '')) AS result_bytes,
              CASE WHEN octet_length(COALESCE($2::jsonb::text, '')) > $3::int
                   THEN encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex')
              END AS result_sha256`,
      [inputMetadataJson, resultMetadataJson, MCP_TASK_METADATA_MAX_BYTES]
    );
    const row = result.rows[0];
    if (!isRecord(row)) {
      throw new TypeError('MCP task metadata size query returned an invalid row.');
    }
    for (const [field, bytesColumn, digestColumn] of [
      ['inputMetadata', 'input_bytes', 'input_sha256'],
      ['resultMetadata', 'result_bytes', 'result_sha256'],
    ] as const) {
      const bytes = Number(row[bytesColumn]);
      if (!(Number.isSafeInteger(bytes) && bytes >= 0)) {
        throw new TypeError(`MCP task ${field} size must be a non-negative safe integer.`);
      }
      if (bytes > MCP_TASK_METADATA_MAX_BYTES) {
        const digest = row[digestColumn];
        if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
          throw new TypeError(`MCP task ${field} digest query returned an invalid SHA-256.`);
        }
        throw new McpTaskMetadataTooLargeError(field, bytes, MCP_TASK_METADATA_MAX_BYTES, digest);
      }
    }
  }
}
