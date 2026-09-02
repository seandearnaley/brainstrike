const TABLE = 'brainstrike_mcp_tasks';
const MAX_METADATA_BYTES = 65_536;
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

export interface McpTaskIdentity {
  readonly generation: number;
  readonly principalId: string;
  readonly resource: string;
  readonly serverId: string;
  readonly taskId: string;
}

export interface McpTaskWriteFence {
  readonly currentGeneration: number;
}

export type McpTaskScope = Omit<McpTaskIdentity, 'taskId'>;

export interface McpTaskRecord extends McpTaskIdentity {
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
  created_at: unknown;
  generation: unknown;
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
  requireText(scope.serverId, 'serverId', 512);
  const resource = requireText(scope.resource, 'resource', 2048);
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
  requireText(scope.principalId, 'principalId', 512);
  if (!(Number.isSafeInteger(scope.generation) && scope.generation >= 0)) {
    throw new TypeError('MCP task generation must be a non-negative safe integer.');
  }
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

function requireNullableText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || TEXT_ENCODER.encode(value).length > 4096) {
    throw new TypeError('MCP task statusMessage must contain 0-4096 UTF-8 bytes.');
  }
  return value;
}

function requireWriteFence(fence: McpTaskWriteFence): number {
  if (!(Number.isSafeInteger(fence.currentGeneration) && fence.currentGeneration >= 0)) {
    throw new TypeError('MCP task currentGeneration must be a non-negative safe integer.');
  }
  return fence.currentGeneration;
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
    createdAt: requireInstant(row.created_at, 'createdAt'),
    generation: Number(row.generation),
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
  if (TERMINAL_STATUSES.has(status) !== (record.terminalAt !== null)) {
    throw new TypeError('MCP task terminal timestamp is inconsistent with status.');
  }
  return record;
}

function identityParams(identity: McpTaskIdentity): unknown[] {
  return [
    identity.serverId,
    identity.resource,
    identity.principalId,
    identity.generation,
    identity.taskId,
  ];
}

/** Durable local Tasks handle store. Lifecycle polling is deliberately out of scope. */
export class McpTaskRepository {
  constructor(
    private readonly db: McpTaskDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  async create(input: CreateMcpTaskInput, fence: McpTaskWriteFence): Promise<McpTaskRecord> {
    requireIdentity(input);
    const currentGeneration = requireWriteFence(fence);
    const status = requireStatus(input.status);
    const inputMetadata = requireMetadata(input.inputMetadata ?? null, 'inputMetadata');
    const resultMetadata = requireMetadata(input.resultMetadata ?? null, 'resultMetadata');
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const statusMessage = requireNullableText(input.statusMessage ?? null);
    if (status === 'input_required' && !inputMetadata) {
      throw new TypeError('An input_required MCP task requires inputMetadata.');
    }
    if ((status === 'completed' || status === 'failed') && !resultMetadata) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    await this.assertMetadataBudgets(inputMetadataJson, resultMetadataJson);
    const at = requireInstant(this.now(), 'clock');
    const result = await this.db.query(
      `INSERT INTO ${TABLE} (
         server_id, resource, principal_id, generation, task_id, status,
         status_message, input_metadata, result_metadata, history,
         created_at, updated_at, terminal_at
       )
       SELECT $1::text, $2::text, $3::text, $4::bigint, $5::text, $6::text,
              $7::text, $8::jsonb, $9::jsonb, $10::jsonb,
              $11::timestamptz, $11::timestamptz, $12::timestamptz
       WHERE $4::bigint = $13::bigint
       RETURNING *`,
      [
        input.serverId,
        input.resource,
        input.principalId,
        input.generation,
        input.taskId,
        status,
        statusMessage,
        inputMetadataJson,
        resultMetadataJson,
        JSON.stringify([{ at: at.toISOString(), status }]),
        at.toISOString(),
        TERMINAL_STATUSES.has(status) ? at.toISOString() : null,
        currentGeneration,
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
       WHERE server_id = $1 AND resource = $2 AND principal_id = $3
         AND generation = $4 AND task_id = $5`,
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
    scope: McpTaskScope,
    options: { readonly limit?: number } = {}
  ): Promise<readonly McpTaskRecord[]> {
    requireScope(scope);
    const limit = options.limit ?? MAX_ACTIVE_MCP_TASKS_PER_SCOPE;
    if (!(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_ACTIVE_MCP_TASKS_PER_SCOPE)) {
      throw new TypeError(
        `MCP task listActive limit must be an integer from 1 to ${MAX_ACTIVE_MCP_TASKS_PER_SCOPE}.`
      );
    }
    const result = await this.db.query(
      `SELECT * FROM ${TABLE}
       WHERE server_id = $1 AND resource = $2 AND principal_id = $3
         AND generation = $4 AND terminal_at IS NULL
       ORDER BY created_at ASC, task_id ASC
       LIMIT $5`,
      [scope.serverId, scope.resource, scope.principalId, scope.generation, limit]
    );
    return result.rows.map(mapRow);
  }

  async update(
    identity: McpTaskIdentity,
    input: UpdateMcpTaskInput,
    fence: McpTaskWriteFence
  ): Promise<McpTaskRecord> {
    requireIdentity(identity);
    const currentGeneration = requireWriteFence(fence);
    const status = requireStatus(input.status);
    const hasInput = Object.hasOwn(input, 'inputMetadata');
    const hasResult = Object.hasOwn(input, 'resultMetadata');
    const hasMessage = Object.hasOwn(input, 'statusMessage');
    const inputMetadata = requireMetadata(input.inputMetadata ?? null, 'inputMetadata');
    const resultMetadata = requireMetadata(input.resultMetadata ?? null, 'resultMetadata');
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const statusMessage = requireNullableText(input.statusMessage ?? null);
    const requiresResult = status === 'completed' || status === 'failed';
    if (hasResult && resultMetadata === null && requiresResult) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    await this.assertMetadataBudgets(
      hasInput ? inputMetadataJson : null,
      hasResult ? resultMetadataJson : null
    );
    const at = requireInstant(this.now(), 'clock');
    const result = await this.db.query(
      `UPDATE ${TABLE}
       SET status = $6,
           status_message = CASE WHEN $7 THEN $8 ELSE status_message END,
           input_metadata = CASE WHEN $9 THEN $10::jsonb ELSE input_metadata END,
           result_metadata = CASE WHEN $11 THEN $12::jsonb ELSE result_metadata END,
           history = (CASE WHEN jsonb_array_length(history) = 32 THEN history - 0 ELSE history END)
                     || $13::jsonb,
           updated_at = $14::timestamptz,
           terminal_at = CASE WHEN $15 THEN $14::timestamptz ELSE NULL END
       WHERE server_id = $1 AND resource = $2 AND principal_id = $3
         AND generation = $4 AND task_id = $5 AND terminal_at IS NULL
         AND $4 = $16
         AND ($6 <> 'input_required' OR
              (CASE WHEN $9 THEN $10::jsonb ELSE input_metadata END) IS NOT NULL)
         AND ($6 NOT IN ('completed', 'failed') OR
              (CASE WHEN $11 THEN $12::jsonb ELSE result_metadata END) IS NOT NULL)
       RETURNING *`,
      [
        ...identityParams(identity),
        status,
        hasMessage,
        statusMessage,
        hasInput,
        inputMetadataJson,
        hasResult,
        resultMetadataJson,
        JSON.stringify([{ at: at.toISOString(), status }]),
        at.toISOString(),
        TERMINAL_STATUSES.has(status),
        currentGeneration,
      ]
    );
    if (result.rows[0] !== undefined) {
      return mapRow(result.rows[0]);
    }
    const existing = await this.get(identity);
    if (identity.generation !== currentGeneration) {
      throw new Error('MCP task handle is missing or stale.');
    }
    if (existing?.terminalAt) {
      throw new Error('A terminal MCP task is immutable.');
    }
    if (
      existing !== null &&
      status === 'input_required' &&
      (hasInput ? inputMetadata === null : existing.inputMetadata === null)
    ) {
      throw new TypeError('An input_required MCP task requires inputMetadata.');
    }
    if (
      existing !== null &&
      requiresResult &&
      (hasResult ? resultMetadata === null : existing.resultMetadata === null)
    ) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    throw new Error('MCP task handle is missing or stale.');
  }

  private async assertMetadataBudgets(
    inputMetadataJson: string | null,
    resultMetadataJson: string | null
  ): Promise<void> {
    if (inputMetadataJson === null && resultMetadataJson === null) {
      return;
    }
    const result = await this.db.query(
      `SELECT octet_length(COALESCE($1::jsonb::text, '')) AS input_bytes,
              octet_length(COALESCE($2::jsonb::text, '')) AS result_bytes`,
      [inputMetadataJson, resultMetadataJson]
    );
    const row = result.rows[0];
    if (!isRecord(row)) {
      throw new TypeError('MCP task metadata size query returned an invalid row.');
    }
    for (const [field, column] of [
      ['inputMetadata', 'input_bytes'],
      ['resultMetadata', 'result_bytes'],
    ] as const) {
      const bytes = Number(row[column]);
      if (!(Number.isSafeInteger(bytes) && bytes >= 0)) {
        throw new TypeError(`MCP task ${field} size must be a non-negative safe integer.`);
      }
      if (bytes > MAX_METADATA_BYTES) {
        throw new TypeError(`MCP task ${field} exceeds ${MAX_METADATA_BYTES} bytes.`);
      }
    }
  }
}
