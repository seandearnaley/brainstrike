import {
  decodeMcpTaskAuthorityRow,
  decodeMcpTaskBlockedDiagnostic,
  decodeMcpTaskClock,
  decodeMcpTaskInputMetadata,
  decodeMcpTaskResultMetadata,
  decodeMcpTaskRow,
  decodeMcpTaskStatus,
  decodeMcpTaskStatusMessage,
  type JsonObject,
  type McpTaskBlockedDiagnostic,
  type McpTaskStatus,
} from './mcp-task-row-schema.js';

export const MCP_TASK_METADATA_MAX_BYTES = 65_536;
const MAX_BLOCKED_DIAGNOSTIC_BYTES = 4096;
const TEXT_ENCODER = new TextEncoder();
const TERMINAL_STATUSES = new Set<McpTaskStatus>(['cancelled', 'completed', 'failed']);
export const MAX_ACTIVE_MCP_TASKS_PER_SCOPE = 256;

export type { JsonObject, McpTaskBlockedDiagnostic, McpTaskStatus };

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

export interface CreateMcpTaskInput extends McpTaskIdentity, UpdateMcpTaskInput {
  /** The host thread whose run created the task; its deletion erases the row. */
  readonly threadId?: string;
}

/** A validated new row; metadata, diagnostic and history are serialized JSON. */
export interface McpTaskInsert {
  readonly at: string;
  readonly blockedDiagnostic: string | null;
  readonly history: string;
  readonly inputMetadata: string | null;
  readonly resultMetadata: string | null;
  readonly status: McpTaskStatus;
  readonly statusMessage: string | null;
  readonly taskId: string;
  readonly terminalAt: string | null;
  readonly threadId: string | null;
}

/** A validated transition; each `has*` flag says whether its field is replaced. */
export interface McpTaskPatch {
  readonly at: string;
  readonly blockedDiagnostic: string | null;
  readonly hasBlocked: boolean;
  readonly hasInput: boolean;
  readonly hasMessage: boolean;
  readonly hasResult: boolean;
  /** One serialized `[{ at, status }]` entry appended to the bounded history. */
  readonly historyEntry: string;
  readonly inputMetadata: string | null;
  readonly resultMetadata: string | null;
  readonly status: McpTaskStatus;
  readonly statusMessage: string | null;
  readonly terminal: boolean;
}

/**
 * One durable Tasks store. Each operation is atomic and returns raw rows in
 * the Tasks tables' snake_case column shape; `McpTaskStore` validates every
 * input and row.
 */
export interface McpTaskStorage {
  get(identity: McpTaskIdentity): Promise<unknown>;
  /** The inserted row, or nothing when the lease is not live. */
  insert(row: McpTaskInsert, lease: McpTaskAuthorityLease): Promise<unknown>;
  listActive(lease: McpTaskAuthorityLease, limit: number): Promise<readonly unknown[]>;
  /** `{inputBytes, inputSha256, resultBytes, resultSha256}`, as this store bounds metadata. */
  measureMetadata(
    inputMetadata: string | null,
    resultMetadata: string | null,
    maxBytes: number
  ): Promise<unknown>;
  /** Rebind the live authority, or retire it and create one; no row means stale. */
  openAuthority(input: McpTaskAuthorityInput, at: string): Promise<readonly unknown[]>;
  retireAuthority(lease: McpTaskAuthorityLease, at: string): Promise<void>;
  /** The updated row, or nothing when the lease, row or transition is refused. */
  update(
    identity: McpTaskIdentity,
    patch: McpTaskPatch,
    lease: McpTaskAuthorityLease
  ): Promise<unknown>;
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

/** Decodes a blocked diagnostic (row column or caller input) into a frozen copy. */
function requireBlockedDiagnostic(value: unknown): McpTaskBlockedDiagnostic | null {
  const diagnostic = decodeMcpTaskBlockedDiagnostic(value);
  if (diagnostic === null) {
    return null;
  }
  return Object.freeze({
    actualBytes: diagnostic.actualBytes,
    code: diagnostic.code,
    field: diagnostic.field,
    maxBytes: diagnostic.maxBytes,
    remoteStatus: diagnostic.remoteStatus,
    sha256: diagnostic.sha256,
  });
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

function assertBlockedDiagnosticBudget(serialized: string | null): void {
  if (
    serialized !== null &&
    TEXT_ENCODER.encode(serialized).length > MAX_BLOCKED_DIAGNOSTIC_BYTES
  ) {
    throw new TypeError(
      `MCP task blockedDiagnostic exceeds ${MAX_BLOCKED_DIAGNOSTIC_BYTES} bytes.`
    );
  }
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
  // Column shapes and per-field rules come from the schema; the invariants
  // below span fields, so they read the decoded record.
  const row = decodeMcpTaskRow(value);
  const status = row.status;
  const record: McpTaskRecord = {
    authorityEpoch: row.authority_epoch,
    blockedDiagnostic: requireBlockedDiagnostic(row.blocked_diagnostic),
    createdAt: row.created_at,
    history: row.history,
    inputMetadata: row.input_metadata,
    principalId: row.principal_id,
    resource: row.resource,
    resultMetadata: row.result_metadata,
    serverId: row.server_id,
    status,
    statusMessage: row.status_message,
    taskId: row.task_id,
    terminalAt: row.terminal_at,
    updatedAt: row.updated_at,
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
  const row = decodeMcpTaskAuthorityRow(value);
  const lease: McpTaskAuthorityLease = {
    authorityEpoch: row.authority_epoch,
    connectionGeneration: row.connection_generation,
    principalId: row.principal_id,
    resource: row.resource,
    runtimeId: row.runtime_id,
    serverId: row.server_id,
  };
  requireAuthorityLease(lease);
  return Object.freeze(lease);
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
export class McpTaskStore {
  constructor(
    private readonly storage: McpTaskStorage,
    private readonly now: () => Date = () => new Date()
  ) {}

  async openAuthority(input: McpTaskAuthorityInput): Promise<McpTaskAuthorityLease> {
    requireAuthorityInput(input);
    const at = decodeMcpTaskClock(this.now()).toISOString();
    const rows = await this.storage.openAuthority(input, at);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('MCP task authority acquisition is stale.');
    }
    if (rows.length !== 1) {
      throw new Error('MCP task authority acquisition did not produce exactly one lease.');
    }
    return mapAuthorityRow(row);
  }

  async retireAuthority(lease: McpTaskAuthorityLease): Promise<void> {
    requireAuthorityLease(lease);
    const at = decodeMcpTaskClock(this.now()).toISOString();
    await this.storage.retireAuthority(lease, at);
  }

  async create(input: CreateMcpTaskInput, lease: McpTaskAuthorityLease): Promise<McpTaskRecord> {
    requireIdentity(input);
    requireMatchingLease(input, lease);
    const threadId =
      input.threadId === undefined ? null : requireText(input.threadId, 'threadId', 512);
    const status = decodeMcpTaskStatus(input.status);
    const inputMetadata = decodeMcpTaskInputMetadata(input.inputMetadata ?? null);
    const resultMetadata = decodeMcpTaskResultMetadata(input.resultMetadata ?? null);
    const blockedDiagnostic = requireBlockedDiagnostic(input.blockedDiagnostic ?? null);
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const blockedDiagnosticJson = serializeMetadata(blockedDiagnostic);
    const statusMessage = decodeMcpTaskStatusMessage(input.statusMessage ?? null);
    if (status === 'input_required' && !inputMetadata) {
      throw new TypeError('An input_required MCP task requires inputMetadata.');
    }
    if ((status === 'completed' || status === 'failed') && !resultMetadata) {
      throw new TypeError('A completed or failed MCP task requires resultMetadata.');
    }
    await this.assertMetadataBudgets(inputMetadataJson, resultMetadataJson);
    assertBlockedDiagnosticBudget(blockedDiagnosticJson);
    const at = decodeMcpTaskClock(this.now()).toISOString();
    const row = await this.storage.insert(
      {
        at,
        blockedDiagnostic: blockedDiagnosticJson,
        history: JSON.stringify([{ at, status }]),
        inputMetadata: inputMetadataJson,
        resultMetadata: resultMetadataJson,
        status,
        statusMessage,
        taskId: input.taskId,
        terminalAt: TERMINAL_STATUSES.has(status) || blockedDiagnostic !== null ? at : null,
        threadId,
      },
      lease
    );
    if (row === undefined) {
      throw new Error('MCP task handle is missing or stale.');
    }
    return mapRow(row);
  }

  async get(identity: McpTaskIdentity): Promise<McpTaskRecord | null> {
    requireIdentity(identity);
    const row = await this.storage.get(identity);
    return row === undefined ? null : mapRow(row);
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
    return (await this.storage.listActive(lease, limit)).map(mapRow);
  }

  async update(
    identity: McpTaskIdentity,
    input: UpdateMcpTaskInput,
    lease: McpTaskAuthorityLease
  ): Promise<McpTaskRecord> {
    requireIdentity(identity);
    requireMatchingLease(identity, lease);
    const status = decodeMcpTaskStatus(input.status);
    const hasBlocked = Object.hasOwn(input, 'blockedDiagnostic');
    const hasInput = Object.hasOwn(input, 'inputMetadata');
    const hasResult = Object.hasOwn(input, 'resultMetadata');
    const hasMessage = Object.hasOwn(input, 'statusMessage');
    const inputMetadata = decodeMcpTaskInputMetadata(input.inputMetadata ?? null);
    const resultMetadata = decodeMcpTaskResultMetadata(input.resultMetadata ?? null);
    const inputMetadataJson = serializeMetadata(inputMetadata);
    const resultMetadataJson = serializeMetadata(resultMetadata);
    const statusMessage = decodeMcpTaskStatusMessage(input.statusMessage ?? null);
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
    assertBlockedDiagnosticBudget(blockedDiagnosticJson);
    const at = decodeMcpTaskClock(this.now()).toISOString();
    const row = await this.storage.update(
      identity,
      {
        at,
        blockedDiagnostic: blockedDiagnosticJson,
        hasBlocked,
        hasInput,
        hasMessage,
        hasResult,
        historyEntry: JSON.stringify([{ at, status }]),
        inputMetadata: inputMetadataJson,
        resultMetadata: resultMetadataJson,
        status,
        statusMessage,
        terminal: TERMINAL_STATUSES.has(status) || blockedDiagnostic !== null,
      },
      lease
    );
    if (row !== undefined) {
      return mapRow(row);
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
    const row = await this.storage.measureMetadata(
      inputMetadataJson,
      resultMetadataJson,
      MCP_TASK_METADATA_MAX_BYTES
    );
    if (!isRecord(row)) {
      throw new TypeError('MCP task metadata size query returned an invalid row.');
    }
    for (const [field, bytesColumn, digestColumn] of [
      ['inputMetadata', 'inputBytes', 'inputSha256'],
      ['resultMetadata', 'resultBytes', 'resultSha256'],
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
