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
export interface McpContentApplicationInvokeOptions {
  readonly signal?: AbortSignal;
}
export interface McpContentApplicationPort {
  execute(
    request: McpContentApplicationRequest,
    options?: McpContentApplicationInvokeOptions
  ): Promise<McpContentApplicationResult>;
}
export const MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES = 256 * 1024;
export const MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES = 4 * 1024 * 1024;

const ERROR_DESCRIPTOR_VALUES = {
  cancelled: ['cancelled', 'mcp_content_cancelled', 'MCP content request was cancelled'],
  hostFailed: ['host', 'mcp_content_host_operation_failed', 'MCP content host operation failed'],
  invalidRequest: [
    'configuration',
    'mcp_content_request_invalid',
    'MCP content request is invalid',
  ],
  invalidResult: ['protocol', 'mcp_content_result_invalid', 'MCP content result is invalid'],
  largeRequest: [
    'request-too-large',
    'mcp_content_request_too_large',
    'MCP content request too large',
  ],
  largeResult: ['result-too-large', 'mcp_content_result_too_large', 'MCP content result too large'],
  mismatchedResult: [
    'protocol',
    'mcp_content_result_type_mismatch',
    'MCP content result type mismatch',
  ],
  notConnected: [
    'not-connected',
    'mcp_content_server_not_connected',
    'MCP content server not connected',
  ],
  retired: [
    'generation-retired',
    'mcp_content_generation_retired',
    'MCP content generation retired',
  ],
  unknownServer: [
    'configuration',
    'mcp_content_server_unknown',
    'MCP content server is not configured',
  ],
  unsupported: [
    'unsupported',
    'mcp_content_operation_unsupported',
    'MCP content operation unsupported',
  ],
} as const;
type McpContentApplicationErrorKind = keyof typeof ERROR_DESCRIPTOR_VALUES;
export type McpContentApplicationErrorDescriptor = {
  [Kind in McpContentApplicationErrorKind]: {
    readonly category: (typeof ERROR_DESCRIPTOR_VALUES)[Kind][0];
    readonly code: (typeof ERROR_DESCRIPTOR_VALUES)[Kind][1];
    readonly message: (typeof ERROR_DESCRIPTOR_VALUES)[Kind][2];
  };
}[McpContentApplicationErrorKind];
export type McpContentApplicationErrorCategory = McpContentApplicationErrorDescriptor['category'];
export type McpContentApplicationErrorCode = McpContentApplicationErrorDescriptor['code'];

export class McpContentApplicationError extends Error {
  readonly category: McpContentApplicationErrorCategory;
  readonly code: McpContentApplicationErrorCode;
  readonly hostError?: McpHostError;

  constructor(kind: McpContentApplicationErrorKind, hostError?: McpHostError) {
    const [category, code, message] = ERROR_DESCRIPTOR_VALUES[kind];
    super(message);
    this.name = 'McpContentApplicationError';
    this.category = category;
    this.code = code;
    if (hostError) {
      this.hostError = Object.freeze({ ...hostError });
    }
  }
}
type ContentHostPort = Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>;
function applicationError(
  kind: McpContentApplicationErrorKind,
  hostError?: McpHostError
): McpContentApplicationError {
  return new McpContentApplicationError(kind, hostError);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseSerializedRequest(request: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw applicationError('invalidRequest');
  }
  if (serialized === undefined) {
    throw applicationError('invalidRequest');
  }
  if (TEXT_ENCODER.encode(serialized).byteLength > MCP_CONTENT_APPLICATION_MAX_REQUEST_BYTES) {
    throw applicationError('largeRequest');
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw applicationError('invalidRequest');
  }
}
function parseAuthority(request: unknown): McpContentAuthority {
  try {
    if (!(isRecord(request) && isRecord(request['authority']))) {
      throw new TypeError('MCP content request authority is invalid');
    }
    const authority = request['authority'];
    if (!Number.isSafeInteger(authority['generation']) || Number(authority['generation']) < 0) {
      throw new TypeError('MCP content request generation is invalid');
    }
    return {
      configuredServerId: parseConfiguredMcpServerId(authority['configuredServerId']),
      generation: Number(authority['generation']),
    };
  } catch {
    throw applicationError('invalidRequest');
  }
}
function findOperationDescriptor(type: string): McpContentOperationDescriptor | undefined {
  return CONTENT_OPERATION_DESCRIPTORS.find((descriptor) => descriptor.type === type);
}
function isContentOperationResult(
  result: McpHostOperationResult
): result is McpContentApplicationResult {
  return findOperationDescriptor(result.type) !== undefined;
}
function isContentOperation(operation: McpHostOperation): operation is McpContentHostOperation {
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
    if (!isRecord(error)) {
      return;
    }
    const parsed = McpHostErrorSchema.safeParse({
      category: Reflect.get(error, 'category'),
      code: Reflect.get(error, 'code'),
      message: Reflect.get(error, 'message'),
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}
function validateResult(
  result: unknown,
  operationType: McpContentOperationType
): McpContentApplicationResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw applicationError('invalidResult');
  }
  if (TEXT_ENCODER.encode(serialized).byteLength > MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES) {
    throw applicationError('largeResult');
  }
  let parsed: McpHostOperationResult;
  try {
    parsed = parseMcpHostOperationResult(result);
  } catch {
    throw applicationError('invalidResult');
  }
  if (parsed.type !== operationType) {
    throw applicationError('mismatchedResult');
  }
  if (!isContentOperationResult(parsed)) {
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
function assertInitialAuthority(
  snapshot: McpHostSnapshot,
  authority: McpContentAuthority,
  descriptor: McpContentOperationDescriptor
): void {
  const error = authorityError(snapshot, authority, descriptor, false);
  if (error) {
    throw error;
  }
}
function assertNotTerminated(termination: McpContentApplicationError | undefined): void {
  if (termination) {
    throw termination;
  }
}
export function createMcpContentApplicationPort(host: ContentHostPort): McpContentApplicationPort {
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
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (options.signal?.aborted) {
        onCallerAbort();
      }
      let unwatch: (() => void) | undefined;
      try {
        assertNotTerminated(termination);
        assertInitialAuthority(host.snapshot(), authority, descriptor);
        assertNotTerminated(termination);
        unwatch = host.watch({ configuredServerIds: [authority.configuredServerId] }, (event) =>
          retireIfChanged(event)
        );
        retireIfChanged(host.snapshot());
        assertNotTerminated(termination);
        const result = await host.invoke(operation, { signal: operationAbort.signal });
        retireIfChanged(host.snapshot());
        assertNotTerminated(termination);
        return validateResult(result, operation.type);
      } catch (error) {
        if (termination) {
          throw termination;
        }
        if (error instanceof McpContentApplicationError) {
          throw error;
        }
        const hostError = readHostError(error);
        if (hostError?.category === 'generation-retired') {
          throw applicationError('retired');
        }
        throw applicationError('hostFailed', hostError);
      } finally {
        options.signal?.removeEventListener('abort', onCallerAbort);
        unwatch?.();
      }
    },
  };
}
