import {
  type ConfiguredMcpServerId,
  type McpHostError,
  McpHostErrorSchema,
  type McpHostOperation,
  type McpHostOperationResult,
  type McpHostPort,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
  parseMcpHostOperation,
} from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';

const TEXT_ENCODER = new TextEncoder();
const CONTENT_OPERATION_DESCRIPTORS = [
  { feature: 'completion', type: 'completion/complete' },
  { feature: 'prompts', type: 'prompts/get' },
  { feature: 'resources', type: 'resources/read' },
] as const;
type McpContentOperationDescriptor = (typeof CONTENT_OPERATION_DESCRIPTORS)[number];
type McpContentOperationType = McpContentOperationDescriptor['type'];
type McpContentHostOperation = Extract<McpHostOperation, { type: McpContentOperationType }>;
export type McpContentApplicationResult = Extract<
  McpHostOperationResult,
  { type: McpContentOperationType }
>;
export interface McpContentAuthority {
  readonly configuredServerId: ConfiguredMcpServerId;
  readonly generation: number;
}
export type McpContentApplicationRequest = {
  [Type in McpContentOperationType]: Omit<
    Extract<McpContentHostOperation, { type: Type }>,
    'configuredServerId'
  > & {
    readonly authority: McpContentAuthority;
  };
}[McpContentOperationType];
export type McpContentApplicationInternalErrorCode =
  | 'mcp-content-host-invoke-failed'
  | 'mcp-content-host-snapshot-failed'
  | 'mcp-content-host-watch-failed'
  | 'mcp-content-result-validation-failed';
export interface McpContentApplicationPortOptions {
  onInternalError(
    code: McpContentApplicationInternalErrorCode,
    cause: unknown
  ): Promise<void> | void;
}
export interface McpContentApplicationPort {
  execute(
    request: McpContentApplicationRequest,
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<McpContentApplicationResult>;
}
export const MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES = 256 * 1024;
export const MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES = 4 * 1024 * 1024;

const ERROR_VALUES = {
  cancelled: ['cancelled', 'mcp_content_cancelled'],
  hostFailed: ['host', 'mcp_content_host_operation_failed'],
  invalidRequest: ['configuration', 'mcp_content_request_invalid'],
  invalidResult: ['protocol', 'mcp_content_result_invalid'],
  invokeFailed: ['host', 'mcp_content_host_invoke_failed'],
  largeRequest: ['request-too-large', 'mcp_content_request_too_large'],
  largeResult: ['result-too-large', 'mcp_content_result_too_large'],
  mismatchedResult: ['protocol', 'mcp_content_result_type_mismatch'],
  notConnected: ['not-connected', 'mcp_content_server_not_connected'],
  retired: ['generation-retired', 'mcp_content_generation_retired'],
  snapshotFailed: ['host', 'mcp_content_host_snapshot_failed'],
  unknownServer: ['configuration', 'mcp_content_server_unknown'],
  unsupported: ['unsupported', 'mcp_content_operation_unsupported'],
  watchFailed: ['host', 'mcp_content_host_watch_failed'],
} as const;
const ERROR_MESSAGES = {
  cancelled: 'MCP content request was cancelled',
  hostFailed: 'MCP content host operation failed',
  invalidRequest: 'MCP content request is invalid',
  invalidResult: 'MCP content result is invalid',
  invokeFailed: 'MCP content host invocation failed',
  largeRequest: 'MCP content request too large',
  largeResult: 'MCP content result too large',
  mismatchedResult: 'MCP content result type mismatch',
  notConnected: 'MCP content server not connected',
  retired: 'MCP content generation retired',
  snapshotFailed: 'MCP content host snapshot failed',
  unknownServer: 'MCP content server is not configured',
  unsupported: 'MCP content operation unsupported',
  watchFailed: 'MCP content host watch failed',
} as const;
type McpContentApplicationErrorKind = keyof typeof ERROR_VALUES;
type McpContentApplicationErrorTuple = (typeof ERROR_VALUES)[McpContentApplicationErrorKind];

export class McpContentApplicationError extends Error {
  readonly category: McpContentApplicationErrorTuple[0];
  readonly code: McpContentApplicationErrorTuple[1];
  readonly hostError?: McpHostError;

  constructor(kind: McpContentApplicationErrorKind, hostError?: McpHostError) {
    const [category, code] = ERROR_VALUES[kind];
    super(ERROR_MESSAGES[kind]);
    this.name = 'McpContentApplicationError';
    this.category = category;
    this.code = code;
    if (hostError) {
      this.hostError = Object.freeze(hostError);
    }
  }
}
function applicationError(kind: McpContentApplicationErrorKind, hostError?: McpHostError) {
  return new McpContentApplicationError(kind, hostError);
}
function reportInternalError(
  options: McpContentApplicationPortOptions,
  code: McpContentApplicationInternalErrorCode,
  cause: unknown
): void {
  try {
    void Promise.resolve(options.onInternalError(code, cause)).catch(() => {});
  } catch {}
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  const array = Array.isArray(value);
  const expectedPrototype = array ? Array.prototype : Object.prototype;
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== expectedPrototype && !(prototype === null && !array)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (array && (keys.length !== value.length + 1 || keys.at(-1) !== 'length')) {
    return false;
  }
  ancestors.add(value);
  const properties = array ? keys.slice(0, -1) : keys;
  const valid = properties.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === 'string' &&
      descriptor?.enumerable === true &&
      'value' in descriptor &&
      isJsonValue(descriptor.value, ancestors)
    );
  });
  ancestors.delete(value);
  return valid;
}
function exceedsUtf8Limit(serialized: string | undefined, limit: number): boolean {
  if (serialized === undefined || serialized.length * 3 <= limit) {
    return false;
  }
  if (serialized.length > limit) {
    return true;
  }
  return TEXT_ENCODER.encode(serialized).byteLength > limit;
}
function parseSerializedRequest(request: unknown): unknown {
  let serialized: string | undefined;
  try {
    if (!isJsonValue(request)) {
      throw new TypeError('MCP content request is not strict JSON');
    }
    serialized = JSON.stringify(request);
  } catch (cause) {
    throw applicationError(cause instanceof RangeError ? 'largeRequest' : 'invalidRequest');
  }
  if (exceedsUtf8Limit(serialized, MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES)) {
    throw applicationError('largeRequest');
  }
  return request;
}
function parseAuthority(request: unknown): McpContentAuthority {
  try {
    if (!(isRecord(request) && isRecord(request['authority']))) {
      throw new TypeError('MCP content request authority is invalid');
    }
    const authority = request['authority'];
    const generation = Number(authority['generation']);
    if (
      Reflect.ownKeys(authority).length !== 2 ||
      !Object.hasOwn(authority, 'configuredServerId') ||
      !Object.hasOwn(authority, 'generation') ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      throw new TypeError('MCP content request authority fields are invalid');
    }
    return {
      configuredServerId: parseConfiguredMcpServerId(authority['configuredServerId']),
      generation,
    };
  } catch {
    throw applicationError('invalidRequest');
  }
}
function findOperationDescriptor(type: string): McpContentOperationDescriptor | undefined {
  return CONTENT_OPERATION_DESCRIPTORS.find((descriptor) => descriptor.type === type);
}
function isContentOperation(
  operation: McpHostOperation | McpHostOperationResult
): operation is McpContentHostOperation | McpContentApplicationResult {
  return findOperationDescriptor(operation.type) !== undefined;
}
function parseOperation(
  request: unknown,
  authority: McpContentAuthority
): { descriptor: McpContentOperationDescriptor; operation: McpContentHostOperation } {
  if (!isRecord(request) || Object.hasOwn(request, 'configuredServerId')) {
    throw applicationError('invalidRequest');
  }
  const operationInput = { ...request };
  Reflect.deleteProperty(operationInput, 'authority');
  let parsed: McpHostOperation;
  try {
    parsed = parseMcpHostOperation({
      ...operationInput,
      configuredServerId: authority.configuredServerId,
    });
  } catch {
    throw applicationError('invalidRequest');
  }
  if (!isContentOperation(parsed)) {
    throw applicationError('invalidRequest');
  }
  const descriptor = findOperationDescriptor(parsed.type);
  if (descriptor === undefined) {
    throw applicationError('invalidRequest');
  }
  return { descriptor, operation: parsed };
}
function readHostError(error: unknown): McpHostError | undefined {
  try {
    const parsed = McpHostErrorSchema.safeParse(
      isRecord(error)
        ? { category: error['category'], code: error['code'], message: error['message'] }
        : error
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
function closeWatch(
  unwatch: (() => void) | undefined,
  options: McpContentApplicationPortOptions
): McpContentApplicationError | undefined {
  try {
    unwatch?.();
    return;
  } catch (cause) {
    reportInternalError(options, 'mcp-content-host-watch-failed', cause);
    return applicationError('watchFailed', readHostError(cause));
  }
}
function validateResult(
  result: unknown,
  operationType: McpContentOperationType,
  options: McpContentApplicationPortOptions
): McpContentApplicationResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch (cause) {
    throw applicationError(cause instanceof RangeError ? 'largeResult' : 'invalidResult');
  }
  if (exceedsUtf8Limit(serialized, MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES)) {
    throw applicationError('largeResult');
  }
  let parsed: McpHostOperationResult;
  try {
    parsed = parseMcpHostOperationResult(result);
  } catch (cause) {
    reportInternalError(options, 'mcp-content-result-validation-failed', cause);
    throw applicationError('invalidResult');
  }
  if (parsed.type !== operationType || !isContentOperation(parsed)) {
    throw applicationError('mismatchedResult');
  }
  return parsed;
}
function authorityError(
  snapshot: McpHostSnapshot,
  authority: McpContentAuthority,
  descriptor: McpContentOperationDescriptor,
  accepted: boolean
): McpContentApplicationError | undefined {
  const server = snapshot.servers.find(
    ({ configuredServerId }) => configuredServerId === authority.configuredServerId
  );
  if (server === undefined) {
    return applicationError(accepted ? 'retired' : 'unknownServer');
  }
  if (server.generation !== authority.generation) {
    return applicationError('retired');
  }
  if (server.state !== 'connected') {
    return applicationError('notConnected');
  }
  if (server.catalog?.features[descriptor.feature] !== true) {
    return applicationError('unsupported');
  }
  return;
}
function assertNotTerminated(termination: McpContentApplicationError | undefined): void {
  if (termination) {
    throw termination;
  }
}
export function createMcpContentApplicationPort(
  host: Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>,
  portOptions: McpContentApplicationPortOptions
): McpContentApplicationPort {
  return {
    async execute(request, options = {}) {
      const parsedRequest = parseSerializedRequest(request);
      const authority = parseAuthority(parsedRequest);
      const { descriptor, operation } = parseOperation(parsedRequest, authority);
      const operationAbort = new AbortController();
      let termination: McpContentApplicationError | undefined;
      const terminate = (next: McpContentApplicationError): void => {
        if (termination) {
          return;
        }
        termination = next;
        operationAbort.abort(next);
      };
      const retireIfChanged = (snapshot: McpHostSnapshot): void => {
        const error = authorityError(snapshot, authority, descriptor, true);
        if (error) {
          terminate(error);
        }
      };
      const onCallerAbort = (): void => terminate(applicationError('cancelled'));
      const snapshot = (): McpHostSnapshot => {
        try {
          return host.snapshot();
        } catch (cause) {
          reportInternalError(portOptions, 'mcp-content-host-snapshot-failed', cause);
          throw applicationError('snapshotFailed', readHostError(cause));
        }
      };
      const invoke = async (): Promise<unknown> => {
        try {
          return await host.invoke(operation, { signal: operationAbort.signal });
        } catch (cause) {
          if (termination) {
            throw termination;
          }
          const hostError = readHostError(cause);
          if (hostError?.category === 'generation-retired') {
            throw applicationError('retired');
          }
          if (hostError) {
            throw applicationError('hostFailed', hostError);
          }
          reportInternalError(portOptions, 'mcp-content-host-invoke-failed', cause);
          throw applicationError('invokeFailed');
        }
      };
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (options.signal?.aborted) {
        onCallerAbort();
      }
      let unwatch: (() => void) | undefined;
      let outcome:
        | { readonly error: unknown; readonly ok: false }
        | { readonly ok: true; readonly value: McpContentApplicationResult };
      try {
        assertNotTerminated(termination);
        const initialError = authorityError(snapshot(), authority, descriptor, false);
        if (initialError) {
          throw initialError;
        }
        assertNotTerminated(termination);
        try {
          unwatch = host.watch({ configuredServerIds: [authority.configuredServerId] }, (event) =>
            retireIfChanged(event)
          );
        } catch (cause) {
          reportInternalError(portOptions, 'mcp-content-host-watch-failed', cause);
          throw applicationError('watchFailed', readHostError(cause));
        }
        retireIfChanged(snapshot());
        assertNotTerminated(termination);
        const result = await invoke();
        retireIfChanged(snapshot());
        assertNotTerminated(termination);
        outcome = { ok: true, value: validateResult(result, operation.type, portOptions) };
      } catch (cause) {
        outcome = { error: cause, ok: false };
      }
      options.signal?.removeEventListener('abort', onCallerAbort);
      const cleanupError = closeWatch(unwatch, portOptions);
      if (!outcome.ok) {
        throw outcome.error;
      }
      if (cleanupError) {
        throw cleanupError;
      }
      return outcome.value;
    },
  };
}
