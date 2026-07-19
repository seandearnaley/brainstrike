import type { RuntimeData } from '@brainstrike/agent/hosted-web';
import { parseWebAssistantRuntimeData } from './web-assistant-runtime-schema';

export class InvalidWebAssistantRuntimeDataError extends Error {
  readonly code = 'invalid_web_assistant_runtime_data';

  constructor(field: string, reason: 'invalid' | 'unsupported' = 'unsupported') {
    super(
      `${reason === 'unsupported' ? 'Unsupported' : 'Invalid'} web assistant runtime field: ${field}`
    );
    this.name = 'InvalidWebAssistantRuntimeDataError';
  }
}

/**
 * Build the TRUSTED runtime for a web assistant request (mirrors the desktop
 * assistant server's trust boundary). Lives in its own PGlite-free module so the
 * trust logic is unit-testable without a Node/PGlite environment.
 *
 * Only explicit request metadata crosses this boundary. The shared UI's model,
 * provider, generation, loop, MCP, and enabled-tool hints are accepted for wire
 * compatibility but are never copied into the runtime: the web server owns the
 * OpenAI provider, key, generation policy, default model, and empty tool
 * registry. Every other field is rejected.
 */
export function resolveWebAssistantRuntime(
  data: unknown,
  apiKey: string,
  signal?: AbortSignal
): RuntimeData {
  const requestRuntime = readClientRuntime(data);
  return {
    ...requestRuntime,
    apiKey,
    provider: 'openai',
    ...(signal ? { signal } : {}),
  };
}

function readClientRuntime(data: unknown): Partial<RuntimeData> {
  const result = parseWebAssistantRuntimeData(data);
  if (!result.success) {
    throw new InvalidWebAssistantRuntimeDataError(result.field, result.reason);
  }
  return result.data;
}
