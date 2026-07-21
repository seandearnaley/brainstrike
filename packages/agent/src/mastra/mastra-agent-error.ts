export type MastraAgentErrorCode =
  | 'mastra_agent_missing_provider'
  | 'mastra_agent_missing_api_key'
  | 'mastra_agent_memory_unavailable'
  | 'mastra_agent_runtime_init_failed'
  | 'mastra_agent_stream_failure'
  | 'mastra_agent_tool_discovery_failure'
  | 'mastra_agent_unsupported_stream_option'
  | 'mastra_agent_unsupported_model_runtime'
  | 'mastra_agent_unsupported_provider'
  | 'mcp_tool_discovery_timeout';

export interface MastraAgentErrorOptions {
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
  readonly detail?: string;
}

export class MastraAgentError extends Error {
  readonly code: MastraAgentErrorCode;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  constructor(code: MastraAgentErrorCode, message: string, options: MastraAgentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MastraAgentError';
    this.code = code;
    this.context = options.context
      ? (Object.freeze({ ...options.context }) as Readonly<Record<string, unknown>>)
      : undefined;
  }
}

export function createMastraAgentError(
  code: MastraAgentErrorCode,
  options: MastraAgentErrorOptions = {}
): MastraAgentError {
  const detail = options.detail?.trim();
  const message = detail && detail.length > 0 ? `${code}: ${detail}` : code;
  return new MastraAgentError(code, message, options);
}

export function isMastraAgentError(value: unknown): value is MastraAgentError {
  return value instanceof MastraAgentError;
}
