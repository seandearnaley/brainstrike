import type { LocalLlmJsonSchema, LocalLlmToolDefinition } from '@brainstrike/assistant-contract';

export interface LocalRuntimeToolConfig {
  description?: string;
  enabled?: boolean;
  id: string;
  inputSchema?: unknown;
  isLocalRuntimeRunnable?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRequiredSchemaEntries(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function normalizeSchemaItems(value: unknown): LocalLlmJsonSchema | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return;
  }

  return {
    type: value['type'],
    ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
  };
}

function normalizeSchemaProperty(value: unknown): LocalLlmJsonSchema | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return;
  }

  const normalized: LocalLlmJsonSchema = {
    type: value['type'],
  };
  if (typeof value['description'] === 'string') {
    normalized.description = value['description'];
  }
  if (Array.isArray(value['enum']) && value['enum'].every((entry) => typeof entry === 'string')) {
    normalized.enum = value['enum'];
  }
  const items = normalizeSchemaItems(value['items']);
  if (items) {
    normalized.items = items;
  }
  return normalized;
}

function normalizeSchemaProperties(value: unknown): Record<string, LocalLlmJsonSchema> | undefined {
  if (!isRecord(value)) {
    return;
  }

  const properties = Object.entries(value).reduce<Record<string, LocalLlmJsonSchema>>(
    (result, [key, propertyValue]) => {
      const normalized = normalizeSchemaProperty(propertyValue);
      if (normalized) {
        result[key] = normalized;
      }
      return result;
    },
    {}
  );

  return Object.keys(properties).length > 0 ? properties : undefined;
}

function normalizeJsonSchema(value: unknown): (LocalLlmJsonSchema & { type: 'object' }) | null {
  if (!isRecord(value) || value['type'] !== 'object') {
    return null;
  }

  const parameters: LocalLlmJsonSchema & { type: 'object' } = {
    type: 'object',
  };
  const properties = normalizeSchemaProperties(value['properties']);
  if (properties) {
    parameters.properties = properties;
  }
  const required = normalizeRequiredSchemaEntries(value['required']);
  if (required) {
    parameters.required = required;
  }

  return parameters;
}

export function buildLocalToolDefinitions(
  tools: readonly LocalRuntimeToolConfig[] | undefined,
  canExecuteTools: boolean
): LocalLlmToolDefinition[] | undefined {
  if (!(tools && tools.length > 0 && canExecuteTools)) {
    return;
  }

  const definitions = tools
    .filter((tool) => tool.enabled !== false && tool.isLocalRuntimeRunnable)
    .map((tool) => {
      const parameters = normalizeJsonSchema(tool.inputSchema);
      if (!parameters) {
        return null;
      }
      return {
        type: 'function' as const,
        function: {
          name: tool.id,
          description: tool.description ?? tool.id,
          parameters,
        },
      };
    })
    .filter((definition): definition is LocalLlmToolDefinition => Boolean(definition));

  return definitions.length > 0 ? definitions : undefined;
}

export function buildLocalToolUnavailableReason(
  tools: readonly LocalRuntimeToolConfig[] | undefined,
  canExecuteTools: boolean
): string {
  if (!canExecuteTools) {
    return 'window.tools.execute is not available in the renderer preload bridge';
  }
  if (!tools) {
    return 'no tool menu was provided to the local runtime adapter';
  }

  const enabledTools = tools.filter((tool) => tool.enabled !== false);
  const runnableTools = enabledTools.filter((tool) => tool.isLocalRuntimeRunnable);
  const schemaBackedTools = runnableTools.filter((tool) => normalizeJsonSchema(tool.inputSchema));

  if (tools.length === 0) {
    return 'the tool menu is empty';
  }
  if (enabledTools.length === 0) {
    return `all ${tools.length} configured tools are disabled`;
  }
  if (runnableTools.length === 0) {
    return `${enabledTools.length} enabled tools are present, but none are marked runnable by the local runtime`;
  }
  if (schemaBackedTools.length === 0) {
    return `${runnableTools.length} runnable tools are present, but none have an object JSON schema`;
  }

  return `${schemaBackedTools.length} runnable tools were configured but local tool definitions were not built`;
}
