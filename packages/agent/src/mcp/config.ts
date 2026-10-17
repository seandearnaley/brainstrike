import {
  McpConfigValidationError,
  mcpConfigValidationIssues,
  parseMcpConfigValue as parseSharedMcpConfigValue,
  McpConfigSchema as SharedMcpConfigSchema,
  type McpServer as SharedMcpServer,
  McpServerSchema as SharedMcpServerSchema,
} from '@brainstrike/assistant-contract/mcp-config';
import { Schema } from 'effect';

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
function throwCapabilityValidationError(error: Schema.SchemaError): never {
  throw new McpConfigValidationError(mcpConfigValidationIssues(error));
}
export const McpServerSchema = SharedMcpServerSchema.check(
  Schema.makeFilter((server) =>
    bearerAuthUnsupported(server)
      ? { issue: UNSUPPORTED_BEARER_MESSAGE, path: ['auth'] }
      : undefined
  )
);
export const McpConfigSchema = SharedMcpConfigSchema.check(
  Schema.makeFilter((config) =>
    config.servers.flatMap((server, index) =>
      bearerAuthUnsupported(server)
        ? [{ issue: UNSUPPORTED_BEARER_MESSAGE, path: ['servers', index, 'auth'] }]
        : []
    )
  )
);
export function parseMcpServerValue(value: unknown): typeof McpServerSchema.Type {
  const parsed = Schema.decodeUnknownResult(McpServerSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  if (!(parsed._tag === 'Success')) {
    return throwCapabilityValidationError(parsed.failure);
  }
  return parsed.success;
}
export function parseMcpConfigValue(value: unknown): ReturnType<typeof parseSharedMcpConfigValue> {
  const parsed = parseSharedMcpConfigValue(value);
  const capabilityScoped = Schema.decodeUnknownResult(McpConfigSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(parsed.config);
  if (!(capabilityScoped._tag === 'Success')) {
    return throwCapabilityValidationError(capabilityScoped.failure);
  }
  return { config: capabilityScoped.success, migrations: parsed.migrations };
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
