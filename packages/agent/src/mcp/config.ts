import {
  McpConfigValidationError,
  parseMcpConfigValue as parseSharedMcpConfigValue,
  McpConfigSchema as SharedMcpConfigSchema,
  type McpServer as SharedMcpServer,
  McpServerSchema as SharedMcpServerSchema,
} from '@brainstrike/assistant-contract/mcp-config';

export * from '@brainstrike/assistant-contract/mcp-config';

const UNSUPPORTED_BEARER_MESSAGE =
  'MCP bearer authentication requires a production credential resolver';

function bearerAuthUnsupported(server: SharedMcpServer): boolean {
  switch (server.transport) {
    case 'stdio':
      return false;
    case 'sse':
    case 'streamable-http':
      return server.auth?.type === 'bearer';
    default: {
      const exhaustiveServer: never = server;
      return exhaustiveServer;
    }
  }
}

function throwCapabilityValidationError(error: {
  issues: readonly { message: string; path: readonly PropertyKey[] }[];
}): never {
  throw new McpConfigValidationError(
    error.issues.map((issue) => ({ message: issue.message, path: issue.path.join('.') }))
  );
}

export const McpServerSchema = SharedMcpServerSchema.superRefine((server, context) => {
  if (bearerAuthUnsupported(server)) {
    context.addIssue({ code: 'custom', message: UNSUPPORTED_BEARER_MESSAGE, path: ['auth'] });
  }
});

export const McpConfigSchema = SharedMcpConfigSchema.superRefine((config, context) => {
  for (const [index, server] of config.servers.entries()) {
    if (bearerAuthUnsupported(server)) {
      context.addIssue({
        code: 'custom',
        message: UNSUPPORTED_BEARER_MESSAGE,
        path: ['servers', index, 'auth'],
      });
    }
  }
});

export function parseMcpServerValue(value: unknown): ReturnType<typeof McpServerSchema.parse> {
  const parsed = McpServerSchema.safeParse(value);
  if (!parsed.success) {
    return throwCapabilityValidationError(parsed.error);
  }
  return parsed.data;
}

export function parseMcpConfigValue(value: unknown): ReturnType<typeof parseSharedMcpConfigValue> {
  const parsed = parseSharedMcpConfigValue(value);
  const capabilityScoped = McpConfigSchema.safeParse(parsed.config);
  if (!capabilityScoped.success) {
    return throwCapabilityValidationError(capabilityScoped.error);
  }
  return { config: capabilityScoped.data, migrations: parsed.migrations };
}

export function parseMcpConfigWithMigrations(
  jsonText: string
): ReturnType<typeof parseMcpConfigValue> {
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch {
    throw new McpConfigValidationError([{ message: 'invalid JSON syntax', path: '' }]);
  }
  return parseMcpConfigValue(value);
}

export function parseMcpConfig(
  jsonText: string
): ReturnType<typeof parseMcpConfigWithMigrations>['config'] {
  return parseMcpConfigWithMigrations(jsonText).config;
}
