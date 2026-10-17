import { Schema, SchemaGetter, SchemaIssue } from 'effect';
import {
  type McpExtensionEnablement,
  McpExtensionEnablementSchema,
  resolveMcpExtensionEnablement,
} from './mcp-extensions.js';
import { ConfiguredMcpServerIdSchema, McpConfiguredAuthSchema } from './mcp-host.js';
export const McpTransportEnum = Schema.Literals(['stdio', 'streamable-http', 'sse']);
export const McpProtocolEnum = Schema.Literals(['legacy', 'auto', '2026-07-28']);
export type McpProtocol = (typeof McpProtocolEnum)['Type'];
export interface McpConfigValidationIssue {
  message: string;
  path: string;
}
export class McpConfigValidationError extends Error {
  readonly code = 'invalid_mcp_config' as const;
  readonly issues: readonly McpConfigValidationIssue[];
  constructor(issues: readonly McpConfigValidationIssue[]) {
    super(JSON.stringify({ code: 'invalid_mcp_config', issues }));
    this.name = 'McpConfigValidationError';
    this.issues = issues;
  }
}
export function toMcpVersionNegotiation(protocol: McpProtocol): {
  mode:
    | 'auto'
    | 'legacy'
    | {
        pin: '2026-07-28';
      };
} {
  if (protocol === '2026-07-28') {
    return { mode: { pin: protocol } };
  }
  return { mode: protocol };
}
export function isInteractiveMcpStdioServer(
  command: string,
  args: readonly string[] | undefined
): boolean {
  const executable = command
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.replace(/\.(?:cmd|exe|ps1)$/u, '');
  return (
    executable === 'mcp-remote' ||
    args?.some((argument) => /^mcp-remote(?:@[^/\s]+)?$/u.test(argument)) === true
  );
}
export function resolveMcpStartupPolicy(server: {
  args?: readonly string[] | undefined;
  auth?:
    | {
        type: string;
      }
    | undefined;
  command?: string | undefined;
  startup?: 'automatic' | 'authentication-required' | undefined;
  transport: string;
}): 'automatic' | 'authentication-required' {
  if (server.startup !== undefined) {
    return server.startup;
  }
  if (server.transport !== 'stdio' && server.auth?.type === 'oauth-user') {
    return 'authentication-required';
  }
  if (
    server.transport === 'stdio' &&
    server.command !== undefined &&
    isInteractiveMcpStdioServer(server.command, server.args)
  ) {
    return 'authentication-required';
  }
  return 'automatic';
}
const NonEmptyStringSchema = Schema.String.check(
  Schema.isMinCodePoints(1, { message: 'must not be empty' })
).check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 ? undefined : { issue: 'must not be blank', path: [] }
  )
);
const SpawnStringSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    value.includes('\0') ? { issue: 'invalid spawn string', path: [] } : undefined
  )
);
const NonEmptySpawnStringSchema = NonEmptyStringSchema.check(
  Schema.makeFilter((value) =>
    value.includes('\0') ? { issue: 'invalid spawn string', path: [] } : undefined
  )
);
const HttpUrlSchema = Schema.Trim.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => value.replaceAll(/[\t\n\r]/gu, '')),
    encode: SchemaGetter.passthrough(),
  })
)
  .check(Schema.makeFilter((value) => (URL.canParse(value) ? undefined : 'Invalid URL')))
  .check(
    Schema.makeFilter((value) =>
      ((value) => {
        if (!URL.canParse(value)) {
          return true;
        }
        const url = new URL(value);
        return url.username.length === 0 && url.password.length === 0;
      })(value)
        ? undefined
        : { issue: 'must not include credentials', path: [] }
    )
  );
const StringRecordSchema = Schema.Record(Schema.String, Schema.String);
const EnvironmentSchema = StringRecordSchema.check(
  Schema.makeFilter((environment) => {
    const issues: {
      issue: string;
      path: readonly PropertyKey[];
    }[] = [];
    for (const [name, value] of Object.entries(environment)) {
      if (name.length === 0 || name.includes('\0') || name.includes('=')) {
        issues.push({ issue: 'invalid environment variable name', path: [name] });
      }
      if (value.includes('\0')) {
        issues.push({ issue: 'invalid environment variable value', path: [name] });
      }
    }
    return issues;
  })
);
const HeadersSchema = StringRecordSchema.check(
  Schema.makeFilter((headers) => {
    const issues: {
      issue: string;
      path: readonly PropertyKey[];
    }[] = [];
    const normalizedNames = new Set<string>();
    for (const [name, value] of Object.entries(headers)) {
      try {
        new Headers([[name, '']]);
      } catch {
        issues.push({ issue: 'invalid HTTP header name', path: [name] });
        continue;
      }
      const normalizedName = name.toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        issues.push({ issue: 'duplicate HTTP header name', path: [name] });
      } else {
        normalizedNames.add(normalizedName);
      }
      try {
        new Headers([[name, value]]);
      } catch {
        issues.push({ issue: 'invalid HTTP header value', path: [name] });
      }
    }
    return issues;
  })
);
const StartupPolicySchema = Schema.optional(
  Schema.Literals(['automatic', 'authentication-required'])
);
const StdioServerSchema = Schema.Struct({
  args: Schema.optional(Schema.mutable(Schema.Array(SpawnStringSchema))),
  command: NonEmptySpawnStringSchema,
  enabledTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  env: Schema.optional(EnvironmentSchema),
  extensions: Schema.optional(McpExtensionEnablementSchema),
  name: ConfiguredMcpServerIdSchema,
  protocol: Schema.optional(McpProtocolEnum),
  startup: StartupPolicySchema,
  transport: Schema.Literal('stdio'),
});
const HttpServerSchema = Schema.Struct({
  auth: Schema.optional(McpConfiguredAuthSchema),
  enabledTools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  extensions: Schema.optional(McpExtensionEnablementSchema),
  headers: Schema.optional(HeadersSchema),
  name: ConfiguredMcpServerIdSchema,
  protocol: Schema.optional(McpProtocolEnum),
  startup: StartupPolicySchema,
  url: HttpUrlSchema,
});
const McpServerInputSchema = Schema.Union(
  [
    StdioServerSchema,
    Schema.Struct({
      ...HttpServerSchema.fields,
      ...{ transport: Schema.Literal('streamable-http') },
    }),
    Schema.Struct({ ...HttpServerSchema.fields, ...{ transport: Schema.Literal('sse') } }),
  ],
  { mode: 'oneOf' }
).check(
  Schema.makeFilter((server) => {
    const issues: {
      issue: string;
      path: readonly PropertyKey[];
    }[] = [];
    if (server.transport === 'sse' && server.auth?.type === 'oauth-user') {
      issues.push({
        issue: 'auth "oauth-user" is not supported with transport "sse"; use "streamable-http"',
        path: ['auth'],
      });
    }
    if (server.transport === 'sse' && server.protocol && server.protocol !== 'legacy') {
      issues.push({ issue: 'legacy SSE transport requires protocol "legacy"', path: ['protocol'] });
    }
    if (
      server.transport === 'stdio' &&
      resolveMcpStartupPolicy(server) === 'authentication-required' &&
      server.protocol === 'auto'
    ) {
      issues.push({
        issue: 'user-paced stdio authorization requires protocol "legacy"',
        path: ['protocol'],
      });
    }
    if (
      server.transport !== 'stdio' &&
      server.auth !== undefined &&
      server.auth.type !== 'none' &&
      Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
    ) {
      issues.push({
        issue: 'auth mode must not be combined with an Authorization header',
        path: ['auth'],
      });
    }
    if (
      server.transport !== 'stdio' &&
      server.auth?.type === 'oauth-user' &&
      server.startup === 'automatic'
    ) {
      issues.push({
        issue: 'OAuth user authentication requires startup "authentication-required"',
        path: ['startup'],
      });
    }
    return issues;
  })
);
const ResolvedMcpServerSchema = Schema.Union(
  [
    Schema.Struct({
      ...StdioServerSchema.fields,
      protocol: McpProtocolEnum,
      startup: Schema.Literals(['automatic', 'authentication-required']),
    }),
    Schema.Struct({
      ...HttpServerSchema.fields,
      protocol: McpProtocolEnum,
      startup: Schema.Literals(['automatic', 'authentication-required']),
      transport: Schema.Literal('streamable-http'),
    }),
    Schema.Struct({
      ...HttpServerSchema.fields,
      protocol: McpProtocolEnum,
      startup: Schema.Literals(['automatic', 'authentication-required']),
      transport: Schema.Literal('sse'),
    }),
  ],
  { mode: 'oneOf' }
);
export const McpServerSchema = McpServerInputSchema.pipe(
  Schema.decodeTo(Schema.toType(ResolvedMcpServerSchema), {
    decode: SchemaGetter.transform((server) => ({
      ...server,
      protocol: server.protocol ?? ('legacy' as const),
      startup: resolveMcpStartupPolicy(server),
    })),
    encode: SchemaGetter.passthrough(),
  })
);
const McpConfigInputSchema = Schema.Struct({
  servers: Schema.mutable(Schema.Array(McpServerInputSchema)),
}).check(
  Schema.makeFilter((config) => {
    const issues: {
      issue: string;
      path: readonly PropertyKey[];
    }[] = [];
    const serverNames = new Set<string>();
    for (const [index, server] of config.servers.entries()) {
      if (serverNames.has(server.name)) {
        issues.push({ issue: 'duplicate server name', path: ['servers', index, 'name'] });
        continue;
      }
      serverNames.add(server.name);
    }
    return issues;
  })
);
export const McpConfigSchema = McpConfigInputSchema.pipe(
  Schema.decodeTo(
    Schema.toType(
      Schema.Struct({ servers: Schema.mutable(Schema.Array(ResolvedMcpServerSchema)) })
    ),
    {
      decode: SchemaGetter.transform((config) => ({
        servers: config.servers.map((server) => ({
          ...server,
          protocol: server.protocol ?? ('legacy' as const),
          startup: resolveMcpStartupPolicy(server),
        })),
      })),
      encode: SchemaGetter.passthrough(),
    }
  )
);
export type McpServerInput = (typeof McpServerSchema)['Encoded'];
export type McpServer = (typeof McpServerSchema)['Type'];
export type ResolvedMcpServer = McpServer;
export type McpConfigInput = (typeof McpConfigSchema)['Encoded'];
export type McpConfig = (typeof McpConfigSchema)['Type'];
export type ResolvedMcpConfig = McpConfig;
export interface McpProtocolMigration {
  code: 'mcp_protocol_defaulted_to_legacy';
  serverIndex: number;
  serverName: string;
}
export function mcpConfigValidationIssues(error: Schema.SchemaError): McpConfigValidationIssue[] {
  const issues: McpConfigValidationIssue[] = [];
  const excess = new Map<string, { keys: string[]; issue: McpConfigValidationIssue }>();
  const formatted = SchemaIssue.makeFormatterStandardSchemaV1({
    leafHook: (issue) =>
      issue._tag === 'UnexpectedKey' ? 'Unrecognized key' : SchemaIssue.defaultLeafHook(issue),
  })(error.issue).issues;
  for (const item of formatted) {
    const path = (item.path ?? []).map((segment) =>
      typeof segment === 'object' ? segment.key : segment
    );
    if (item.message !== 'Unrecognized key') {
      issues.push({ message: item.message, path: path.join('.') });
      continue;
    }
    const key = JSON.stringify(path.pop());
    const parent = path.join('.');
    const group = excess.get(parent);
    if (group) {
      group.keys.push(key);
      group.issue.message = `Unrecognized keys: ${group.keys.join(', ')}`;
      continue;
    }
    const issue = { message: `Unrecognized key: ${key}`, path: parent };
    excess.set(parent, { issue, keys: [key] });
    issues.push(issue);
  }
  return issues;
}
export function parseMcpServerValue(value: unknown): ResolvedMcpServer {
  const parsed = Schema.decodeUnknownResult(McpServerSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  if (!(parsed._tag === 'Success')) {
    throw new McpConfigValidationError(mcpConfigValidationIssues(parsed.failure));
  }
  return parsed.success;
}
export function parseMcpConfigValue(value: unknown): {
  config: ResolvedMcpConfig;
  migrations: McpProtocolMigration[];
} {
  const parsed = Schema.decodeUnknownResult(McpConfigInputSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  if (!(parsed._tag === 'Success')) {
    throw new McpConfigValidationError(mcpConfigValidationIssues(parsed.failure));
  }
  const migrations = parsed.success.servers.flatMap((server, serverIndex) =>
    server.protocol === undefined
      ? [
          {
            code: 'mcp_protocol_defaulted_to_legacy' as const,
            serverIndex,
            serverName: server.name,
          },
        ]
      : []
  );
  return {
    config: Schema.decodeUnknownSync(McpConfigSchema, { errors: 'all', onExcessProperty: 'error' })(
      parsed.success
    ),
    migrations,
  };
}
/**
 * Folds the global extension preference into every server's own override so
 * the resolved private definition carries the EFFECTIVE state (BST-1604).
 * Because `extensions` is part of the private definition, a flipped dial
 * changes the server's config ref, which advances the connection generation
 * and retires the old authority exactly like a server-definition replacement.
 */
export function applyMcpExtensionPreferences(
  config: ResolvedMcpConfig,
  preferences: McpExtensionEnablement
): ResolvedMcpConfig {
  return {
    servers: config.servers.map((server) => ({
      ...server,
      extensions: resolveMcpExtensionEnablement(server.extensions, preferences),
    })),
  };
}
