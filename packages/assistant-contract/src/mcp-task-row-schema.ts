/**
 * Effect Schema field rules for the MCP task tables
 * (docs/agents/effect-boundary.md § "Decoding and tooling").
 *
 * Every rule is declared once and serves both directions the store checks:
 * rows read back from its storage and inputs a caller hands in. Each schema
 * carries the store's own error sentence as its `message`, so a failure reads
 * the same as before, followed by the path to the failing column. The
 * cross-field invariants (history order, terminal timestamps, the canonical
 * resource URL) stay in `mcp-task-store.ts`, where they read the decoded
 * record.
 */
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema, SchemaTransformation } from 'effect';

const MCP_TASK_STATUSES = [
  'cancelled',
  'completed',
  'failed',
  'input_required',
  'working',
] as const;
export type McpTaskStatus = (typeof MCP_TASK_STATUSES)[number];

type JsonValue = boolean | null | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface McpTaskBlockedDiagnostic extends JsonObject {
  readonly actualBytes: number;
  readonly code: 'mcp_task_state_too_large';
  readonly field: 'inputMetadata' | 'resultMetadata';
  readonly maxBytes: number;
  readonly remoteStatus: McpTaskStatus;
  readonly sha256: string;
}

const TEXT_ENCODER = new TextEncoder();
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const BLOCKED_DIAGNOSTIC_KEYS = 'actualBytes,code,field,maxBytes,remoteStatus,sha256';

const utf8ByteLength = (value: string): number => TEXT_ENCODER.encode(value).length;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    isRecord(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

/** Non-empty text of at most `maxBytes` UTF-8 bytes. */
function mcpTaskText(field: string, maxBytes: number) {
  const message = `MCP task ${field} must contain 1-${maxBytes} UTF-8 bytes.`;
  return Schema.String.annotate({ message }).check(
    Schema.makeFilter((value: string) => value.length > 0 && utf8ByteLength(value) <= maxBytes, {
      message,
    })
  );
}

function uuidV7(field: string) {
  return mcpTaskText(field, 36).check(
    Schema.makeFilter((value: string) => UUID_V7.test(value), {
      message: `MCP task ${field} must be a UUIDv7.`,
    })
  );
}

const status = Schema.Literals(MCP_TASK_STATUSES).annotate({
  message: 'MCP task status is invalid.',
});

/** A `Date`, or anything whose string form parses as one; decodes to a fresh `Date`. */
function instant(field: string) {
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.Date.annotate({ message: `MCP task ${field} must be a valid timestamp.` }),
      SchemaTransformation.transform<Date, unknown>({
        decode: (value) => (value instanceof Date ? new Date(value) : new Date(String(value))),
        encode: (value) => value,
      })
    )
  );
}

function metadata(field: string) {
  return Schema.declare(
    (value: unknown): value is JsonObject | null => value === null || isJsonObject(value),
    { message: `MCP task ${field} must be a JSON object or null.` }
  );
}

const statusMessage = Schema.declare(
  (value: unknown): value is string | null =>
    value === null || (typeof value === 'string' && utf8ByteLength(value) <= 4096),
  { message: 'MCP task statusMessage must contain 0-4096 UTF-8 bytes.' }
);

const blockedDiagnosticValuesMessage = 'MCP task blockedDiagnostic values are invalid.';
const blockedDiagnosticValues = Schema.Struct({
  actualBytes: Schema.Finite.annotate({ message: blockedDiagnosticValuesMessage }),
  code: Schema.Literal('mcp_task_state_too_large').annotate({
    message: blockedDiagnosticValuesMessage,
  }),
  field: Schema.Literals(['inputMetadata', 'resultMetadata']).annotate({
    message: blockedDiagnosticValuesMessage,
  }),
  // The diagnostic records the budget in force when the row was written, so it
  // validates structurally rather than against today's constant.
  maxBytes: Schema.Finite.annotate({ message: blockedDiagnosticValuesMessage }),
  remoteStatus: status,
  sha256: Schema.String.annotate({ message: blockedDiagnosticValuesMessage }).check(
    Schema.isPattern(SHA256_HEX, { message: blockedDiagnosticValuesMessage })
  ),
}).check(
  Schema.makeFilter(
    ({ actualBytes, maxBytes }) =>
      Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      Number.isSafeInteger(actualBytes) &&
      actualBytes > maxBytes,
    { message: blockedDiagnosticValuesMessage }
  )
);

/** JSON object with exactly the six diagnostic keys, then value rules; `null` passes through. */
const blockedDiagnostic = Schema.NullOr(
  Schema.Unknown.check(
    Schema.makeFilter(isJsonObject, {
      message: 'MCP task blockedDiagnostic must be a JSON object or null.',
    }),
    Schema.makeFilter(
      (value: unknown) =>
        isRecord(value) && Object.keys(value).sort().join(',') === BLOCKED_DIAGNOSTIC_KEYS,
      { message: 'MCP task blockedDiagnostic fields are invalid.' }
    )
  ).pipe(Schema.decodeTo(blockedDiagnosticValues, SchemaTransformation.passthroughSupertype()))
);

const historyMessage = 'MCP task history must contain 1-32 entries.';
const history = Schema.Array(
  Schema.Struct({ at: instant('history.at'), status }).annotate({
    message: 'MCP task history entry must be an object.',
  })
)
  .annotate({ message: historyMessage })
  .check(
    Schema.isMinLength(1, { message: historyMessage }),
    Schema.isMaxLength(32, { message: historyMessage })
  );

const mcpTaskRow = Schema.Struct({
  authority_epoch: uuidV7('authorityEpoch'),
  blocked_diagnostic: blockedDiagnostic,
  created_at: instant('createdAt'),
  history,
  input_metadata: metadata('inputMetadata'),
  principal_id: mcpTaskText('principalId', 512),
  resource: mcpTaskText('resource', 2048),
  result_metadata: metadata('resultMetadata'),
  server_id: mcpTaskText('serverId', 512),
  status,
  status_message: statusMessage,
  task_id: mcpTaskText('taskId', 1024),
  terminal_at: Schema.NullOr(instant('terminalAt')).annotate({
    message: 'MCP task terminalAt must be a valid timestamp.',
  }),
  updated_at: instant('updatedAt'),
}).annotate({ message: 'MCP task row must be an object.' });

const connectionGeneration = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Finite.check(
      Schema.makeFilter((value: number) => Number.isSafeInteger(value) && value >= 0, {
        message: 'MCP task connectionGeneration must be a non-negative safe integer.',
      })
    ).annotate({ message: 'MCP task connectionGeneration must be a non-negative safe integer.' }),
    SchemaTransformation.transform<number, unknown>({
      decode: (value) => Number(value),
      encode: (value) => value,
    })
  )
);

const mcpTaskAuthorityRow = Schema.Struct({
  authority_epoch: uuidV7('authorityEpoch'),
  connection_generation: connectionGeneration,
  principal_id: mcpTaskText('principalId', 512),
  resource: mcpTaskText('resource', 2048),
  runtime_id: mcpTaskText('runtimeId', 512),
  server_id: mcpTaskText('serverId', 512),
}).annotate({ message: 'MCP task authority row must be an object.' });

export const decodeMcpTaskRow = makeThrowingDecoder(mcpTaskRow);
export const decodeMcpTaskAuthorityRow = makeThrowingDecoder(mcpTaskAuthorityRow);
export const decodeMcpTaskStatus = makeThrowingDecoder(status);
export const decodeMcpTaskStatusMessage = makeThrowingDecoder(statusMessage);
export const decodeMcpTaskBlockedDiagnostic = makeThrowingDecoder(blockedDiagnostic);
export const decodeMcpTaskInputMetadata = makeThrowingDecoder(metadata('inputMetadata'));
export const decodeMcpTaskResultMetadata = makeThrowingDecoder(metadata('resultMetadata'));
export const decodeMcpTaskClock = makeThrowingDecoder(instant('clock'));
