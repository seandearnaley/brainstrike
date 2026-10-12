import type { HostMcpContentService, HostParams, HostResults } from '@brainstrike/agent-host';
import { type McpHostPort, parseConfiguredMcpServerId } from '@brainstrike/assistant-contract';
import {
  createMcpContentApplicationPort,
  McpContentApplicationError,
  type McpContentApplicationPort,
  type McpContentApplicationRequest,
  type McpContentApplicationResult,
} from '@brainstrike/assistant-service/mcp-content-application-port';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('McpContentService');

type ContentFailure = Extract<HostResults['mcp/content/read'], { ok: false }>['error'];
type ContentOutcome<Type extends McpContentApplicationResult['type']> =
  | { readonly ok: true; readonly result: Extract<McpContentApplicationResult, { type: Type }> }
  | { readonly error: ContentFailure; readonly ok: false };

const GENERIC_FAILURE: ContentFailure = {
  category: 'host',
  code: 'mcp_content_request_failed',
  message: 'MCP content request failed',
};
const LIFECYCLE_CLOSED: ContentFailure = {
  category: 'not-connected',
  code: 'mcp_content_lifecycle_closed',
  message: 'MCP lifecycle is closed for cleanup',
};

export interface McpContentServiceOptions {
  /** Whether a read may run now; it waits out a config change in flight. */
  readonly admit: () => Promise<boolean>;
  readonly host: Pick<McpHostPort, 'invoke' | 'snapshot' | 'watch'>;
}

/**
 * The desktop's MCP content browsing (BST-1930 c5d), served in the host over
 * the content application port Main used to own. Only the port's fixed
 * taxonomy crosses to a window: a server's own error text stays in the port's
 * sink, and anything outside the taxonomy is logged here and replaced with one
 * generic failure.
 */
export class McpContentService implements HostMcpContentService {
  readonly #port: McpContentApplicationPort;

  constructor(private readonly options: McpContentServiceOptions) {
    this.#port = createMcpContentApplicationPort(options.host, {
      onInternalError: (code, cause) => {
        logger.error('MCP content internal failure', { cause, code });
      },
    });
  }

  complete(
    request: HostParams<'mcp/content/complete'>
  ): Promise<HostResults['mcp/content/complete']> {
    return this.#run<'completion/complete'>(() => ({
      argument: request.argument,
      authority: authority(request.authority),
      ...(request.context && { context: request.context }),
      ref: request.ref,
      type: 'completion/complete',
    }));
  }

  prompt(request: HostParams<'mcp/content/prompt'>): Promise<HostResults['mcp/content/prompt']> {
    return this.#run<'prompts/get'>(() => ({
      ...(request.arguments && { arguments: request.arguments }),
      authority: authority(request.authority),
      name: request.name,
      type: 'prompts/get',
    }));
  }

  read(request: HostParams<'mcp/content/read'>): Promise<HostResults['mcp/content/read']> {
    return this.#run<'resources/read'>(() => ({
      authority: authority(request.authority),
      type: 'resources/read',
      uri: request.uri,
    }));
  }

  async #run<Type extends McpContentApplicationResult['type']>(
    buildRequest: () => McpContentApplicationRequest
  ): Promise<ContentOutcome<Type>> {
    if (!(await this.options.admit())) {
      return { error: LIFECYCLE_CLOSED, ok: false };
    }
    let request: McpContentApplicationRequest;
    try {
      request = buildRequest();
    } catch {
      return { error: failure(new McpContentApplicationError('invalidRequest')), ok: false };
    }
    try {
      const result = await this.#port.execute(request);
      return { ok: true, result: result as Extract<McpContentApplicationResult, { type: Type }> };
    } catch (cause) {
      return { error: failure(cause), ok: false };
    }
  }
}

function authority(
  value: HostParams<'mcp/content/read'>['authority']
): McpContentApplicationRequest['authority'] {
  return {
    configuredServerId: parseConfiguredMcpServerId(value.configuredServerId),
    generation: value.generation,
  };
}

function failure(cause: unknown): ContentFailure {
  if (cause instanceof McpContentApplicationError) {
    return { category: cause.category, code: cause.code, message: cause.message };
  }
  logger.error(GENERIC_FAILURE.message, { error: cause });
  return GENERIC_FAILURE;
}
