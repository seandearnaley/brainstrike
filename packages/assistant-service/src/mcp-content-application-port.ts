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

type McpContentOperationType = 'completion/complete' | 'prompts/get' | 'resources/read';
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

export const MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES = 4 * 1024 * 1024;

export type McpContentApplicationErrorCategory =
  | 'cancelled'
  | 'configuration'
  | 'generation-retired'
  | 'host'
  | 'protocol'
  | 'result-too-large';

export type McpContentApplicationErrorCode =
  | 'mcp_content_cancelled'
  | 'mcp_content_generation_retired'
  | 'mcp_content_host_operation_failed'
  | 'mcp_content_request_invalid'
  | 'mcp_content_result_invalid'
  | 'mcp_content_result_too_large'
  | 'mcp_content_result_type_mismatch'
  | 'mcp_content_server_unknown';

function errorMessage(code: McpContentApplicationErrorCode): string {
  switch (code) {
    case 'mcp_content_cancelled':
      return 'MCP content request was cancelled';
    case 'mcp_content_generation_retired':
      return 'MCP content authority generation retired';
    case 'mcp_content_host_operation_failed':
      return 'MCP content host operation failed';
    case 'mcp_content_request_invalid':
      return 'MCP content request is invalid';
    case 'mcp_content_result_invalid':
      return 'MCP content result is invalid';
    case 'mcp_content_result_too_large':
      return 'MCP content result exceeds the application byte limit';
    case 'mcp_content_result_type_mismatch':
      return 'MCP content host returned the wrong operation result';
    case 'mcp_content_server_unknown':
      return 'MCP content server is not configured';
  }
}

export class McpContentApplicationError extends Error {
  readonly category: McpContentApplicationErrorCategory;
  readonly code: McpContentApplicationErrorCode;
  readonly hostError?: McpHostError;

  constructor(
    category: McpContentApplicationErrorCategory,
    code: McpContentApplicationErrorCode,
    hostError?: McpHostError
  ) {
    super(errorMessage(code));
    this.name = 'McpContentApplicationError';
    this.category = category;
    this.code = code;
    if (hostError) {
      this.hostError = Object.freeze({ ...hostError });
    }
  }
}

type ContentHostPort = Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>;
type Termination = 'cancelled' | 'generation-retired';

function applicationError(
  category: McpContentApplicationErrorCategory,
  code: McpContentApplicationErrorCode,
  hostError?: McpHostError
): McpContentApplicationError {
  return new McpContentApplicationError(category, code, hostError);
}

function parseAuthority(request: McpContentApplicationRequest): McpContentAuthority {
  const authority = request.authority;
  if (!Number.isSafeInteger(authority.generation) || authority.generation < 0) {
    throw applicationError('configuration', 'mcp_content_request_invalid');
  }
  try {
    return {
      configuredServerId: parseConfiguredMcpServerId(authority.configuredServerId),
      generation: authority.generation,
    };
  } catch {
    throw applicationError('configuration', 'mcp_content_request_invalid');
  }
}

function optionalMeta(request: McpContentApplicationRequest): {
  _meta?: McpHostOperation['_meta'];
} {
  return request._meta === undefined ? {} : { _meta: request._meta };
}

function parseOperation(
  request: McpContentApplicationRequest,
  authority: McpContentAuthority
): McpContentHostOperation {
  let parsed: McpHostOperation;
  try {
    switch (request.type) {
      case 'resources/read':
        parsed = parseMcpHostOperation({
          ...optionalMeta(request),
          configuredServerId: authority.configuredServerId,
          type: request.type,
          uri: request.uri,
        });
        break;
      case 'prompts/get':
        parsed = parseMcpHostOperation({
          ...optionalMeta(request),
          ...(request.arguments === undefined ? {} : { arguments: request.arguments }),
          configuredServerId: authority.configuredServerId,
          name: request.name,
          type: request.type,
        });
        break;
      case 'completion/complete':
        parsed = parseMcpHostOperation({
          ...optionalMeta(request),
          argument: request.argument,
          configuredServerId: authority.configuredServerId,
          ...(request.context === undefined ? {} : { context: request.context }),
          ref: request.ref,
          type: request.type,
        });
        break;
      default:
        throw applicationError('configuration', 'mcp_content_request_invalid');
    }
  } catch (error) {
    if (error instanceof McpContentApplicationError) {
      throw error;
    }
    throw applicationError('configuration', 'mcp_content_request_invalid');
  }
  if (
    parsed.type !== 'completion/complete' &&
    parsed.type !== 'prompts/get' &&
    parsed.type !== 'resources/read'
  ) {
    throw applicationError('configuration', 'mcp_content_request_invalid');
  }
  return parsed;
}

function findAuthority(
  snapshot: McpHostSnapshot,
  configuredServerId: ConfiguredMcpServerId
): number | undefined {
  return snapshot.servers.find((server) => server.configuredServerId === configuredServerId)
    ?.generation;
}

function readHostError(error: unknown): McpHostError | undefined {
  try {
    const parsed = McpHostErrorSchema.safeParse(error);
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
    throw applicationError('protocol', 'mcp_content_result_invalid');
  }
  if (TEXT_ENCODER.encode(serialized).byteLength > MCP_CONTENT_APPLICATION_MAX_RESULT_BYTES) {
    throw applicationError('result-too-large', 'mcp_content_result_too_large');
  }
  let parsed: McpHostOperationResult;
  try {
    parsed = parseMcpHostOperationResult(result);
  } catch {
    throw applicationError('protocol', 'mcp_content_result_invalid');
  }
  if (parsed.type !== operationType) {
    throw applicationError('protocol', 'mcp_content_result_type_mismatch');
  }
  switch (parsed.type) {
    case 'completion/complete':
    case 'prompts/get':
    case 'resources/read':
      return parsed;
    default:
      throw applicationError('protocol', 'mcp_content_result_type_mismatch');
  }
}

function initialAuthorityError(
  snapshot: McpHostSnapshot,
  authority: McpContentAuthority
): McpContentApplicationError | undefined {
  const generation = findAuthority(snapshot, authority.configuredServerId);
  if (generation === undefined) {
    return applicationError('configuration', 'mcp_content_server_unknown');
  }
  if (generation !== authority.generation) {
    return applicationError('generation-retired', 'mcp_content_generation_retired');
  }
  return;
}

function assertInitialAuthority(snapshot: McpHostSnapshot, authority: McpContentAuthority): void {
  const error = initialAuthorityError(snapshot, authority);
  if (error) {
    throw error;
  }
}

function terminationError(termination: Termination): McpContentApplicationError {
  return termination === 'cancelled'
    ? applicationError('cancelled', 'mcp_content_cancelled')
    : applicationError('generation-retired', 'mcp_content_generation_retired');
}

function assertNotTerminated(termination: Termination | undefined): void {
  if (termination) {
    throw terminationError(termination);
  }
}

export function createMcpContentApplicationPort(host: ContentHostPort): McpContentApplicationPort {
  return {
    async execute(request, options = {}) {
      const authority = parseAuthority(request);
      const operation = parseOperation(request, authority);
      const operationAbort = new AbortController();
      let termination: Termination | undefined;
      const terminate = (next: Termination) => {
        if (termination) {
          return;
        }
        termination = next;
        operationAbort.abort(terminationError(next));
      };
      const retireIfChanged = (snapshot: McpHostSnapshot) => {
        if (findAuthority(snapshot, authority.configuredServerId) !== authority.generation) {
          terminate('generation-retired');
        }
      };
      const onCallerAbort = () => terminate('cancelled');
      options.signal?.addEventListener('abort', onCallerAbort, { once: true });
      if (options.signal?.aborted) {
        onCallerAbort();
      }
      let unwatch: (() => void) | undefined;
      try {
        assertNotTerminated(termination);
        assertInitialAuthority(host.snapshot(), authority);
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
          throw terminationError(termination);
        }
        if (error instanceof McpContentApplicationError) {
          throw error;
        }
        const hostError = readHostError(error);
        if (hostError?.category === 'generation-retired') {
          throw applicationError('generation-retired', 'mcp_content_generation_retired');
        }
        throw applicationError('host', 'mcp_content_host_operation_failed', hostError);
      } finally {
        options.signal?.removeEventListener('abort', onCallerAbort);
        unwatch?.();
      }
    },
  };
}
