import { type RuntimeData, resolveRequestPermissionPolicy } from '@brainstrike/agent';

const FORWARDED_REQUEST_FIELDS = [
  'contextTokenCount',
  'mainRootId',
  'mainRootPath',
  'permissionPolicyRequest',
  'projectId',
  'selectionFilePaths',
  'selectionFilePathsFromOtherRoots',
  'selectionFolderId',
  'tokenBudget',
  'workspaceContext',
  'workspaceIndexBlockedReason',
  'workspaceIndexEmbeddingSetId',
  'workspaceIndexingEnabled',
  'workspaceIndexingMode',
  'workspaceIndexingPaused',
  'workspaceIndexLastError',
  'workspaceIndexQueueProgress',
  'workspaceIndexStatusState',
  'workspaceRootPath',
] as const satisfies readonly (keyof RuntimeData)[];
const ACCEPTED_WIRE_FIELDS = new Set<string>([
  ...FORWARDED_REQUEST_FIELDS,
  'agentLoop',
  'enabledNativeToolIds',
  'mcpEnabled',
  'model',
  'modelSettings',
  'provider',
  'providerOptions',
]);

export class InvalidWebAssistantRuntimeDataError extends Error {
  readonly code = 'invalid_web_assistant_runtime_data';

  constructor(field: string) {
    super(`Unsupported web assistant runtime field: ${field}`);
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
  const clientRuntime = readClientRuntime(data);
  const { permissionPolicyRequest, ...requestRuntime } = clientRuntime;
  const permissionPolicy = resolveRequestPermissionPolicy(permissionPolicyRequest);
  return {
    ...requestRuntime,
    apiKey,
    provider: 'openai',
    ...(signal ? { signal } : {}),
    ...(permissionPolicy ? { permissionPolicy } : {}),
  };
}

function readClientRuntime(
  data: unknown
): Partial<Pick<RuntimeData, (typeof FORWARDED_REQUEST_FIELDS)[number]>> {
  if (data === undefined) {
    return {};
  }
  if (!(data && typeof data === 'object' && !Array.isArray(data))) {
    throw new InvalidWebAssistantRuntimeDataError('data');
  }
  const record = data as Record<string, unknown>;
  const unsupportedField = Object.keys(record).find((field) => !ACCEPTED_WIRE_FIELDS.has(field));
  if (unsupportedField) {
    throw new InvalidWebAssistantRuntimeDataError(unsupportedField);
  }
  return Object.fromEntries(
    FORWARDED_REQUEST_FIELDS.filter((field) => field in record).map((field) => [
      field,
      record[field],
    ])
  ) as Partial<Pick<RuntimeData, (typeof FORWARDED_REQUEST_FIELDS)[number]>>;
}
