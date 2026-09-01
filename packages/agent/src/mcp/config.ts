import {
  McpConfigSchema as SharedMcpConfigSchema,
  McpConfigValidationError,
  McpServerSchema as SharedMcpServerSchema,
  parseMcpConfigValue as parseSharedMcpConfigValue,
  parseMcpServerValue as parseSharedMcpServerValue,
} from '@brainstrike/assistant-contract/mcp-config';

export * from '@brainstrike/assistant-contract/mcp-config';

const UNSUPPORTED_BEARER_MESSAGE =
  'MCP bearer authentication requires a production credential resolver';

function bearerAuthUnsupported(server: { auth?: { type: string } | undefined }): boolean {
  return server.auth?.type === 'bearer';
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

export function parseMcpServerValue(
  value: unknown
): ReturnType<typeof parseSharedMcpServerValue> {
  const server = parseSharedMcpServerValue(value);
  if (bearerAuthUnsupported(server)) {
    throw new McpConfigValidationError([{ message: UNSUPPORTED_BEARER_MESSAGE, path: 'auth' }]);
  }
  return server;
}

export function parseMcpConfigValue(
  value: unknown
): ReturnType<typeof parseSharedMcpConfigValue> {
  const parsed = parseSharedMcpConfigValue(value);
  const serverIndex = parsed.config.servers.findIndex(bearerAuthUnsupported);
  if (serverIndex !== -1) {
    throw new McpConfigValidationError([
      { message: UNSUPPORTED_BEARER_MESSAGE, path: `servers.${serverIndex}.auth` },
    ]);
  }
  return parsed;
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
