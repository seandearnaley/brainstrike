export type MastraAgentErrorCode =
  | 'mastra_agent_missing_provider'
  | 'mastra_agent_missing_api_key'
  | 'mastra_agent_runtime_init_failed'
  | 'mastra_agent_stream_failure'
  | 'mcp_tool_discovery_timeout';

export interface MastraAgentErrorOptions {
  readonly detail?: string;
  readonly cause?: unknown;
  readonly context?: Record<string, unknown>;
}

export class MastraAgentError extends Error {
  readonly code: MastraAgentErrorCode;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  constructor(code: MastraAgentErrorCode, message: string, options: MastraAgentErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
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
