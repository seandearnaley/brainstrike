import { z } from 'zod';
import {
  type McpExtensionEnablement,
  McpExtensionEnablementSchema,
  resolveMcpExtensionEnablement,
} from './mcp-extensions.js';
import { ConfiguredMcpServerIdSchema, McpConfiguredAuthSchema } from './mcp-host.js';

export const McpTransportEnum = z.enum(['stdio', 'streamable-http', 'sse']);
export const McpProtocolEnum = z.enum(['legacy', 'auto', '2026-07-28']);
export type McpProtocol = z.infer<typeof McpProtocolEnum>;

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
  mode: 'auto' | 'legacy' | { pin: '2026-07-28' };
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
  auth?: { type: string } | undefined;
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

const NonEmptyStringSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((value) => value.trim().length > 0, 'must not be blank');
const SpawnStringSchema = z
  .string()
  .refine((value) => !value.includes('\0'), 'invalid spawn string');
const NonEmptySpawnStringSchema = NonEmptyStringSchema.refine(
  (value) => !value.includes('\0'),
  'invalid spawn string'
);
const HttpUrlSchema = z.url({ protocol: /^https?$/u }).refine((value) => {
  if (!URL.canParse(value)) {
    return true;
  }
  const url = new URL(value);
  return url.username.length === 0 && url.password.length === 0;
}, 'must not include credentials');
const StringRecordSchema = z.record(z.string(), z.string());
const EnvironmentSchema = StringRecordSchema.superRefine((environment, context) => {
  for (const [name, value] of Object.entries(environment)) {
    if (name.length === 0 || name.includes('\0') || name.includes('=')) {
      context.addIssue({
        code: 'custom',
        message: 'invalid environment variable name',
        path: [name],
      });
    }
    if (value.includes('\0')) {
      context.addIssue({
        code: 'custom',
        message: 'invalid environment variable value',
        path: [name],
      });
    }
  }
});
const HeadersSchema = StringRecordSchema.superRefine((headers, context) => {
  const normalizedNames = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    try {
      new Headers([[name, '']]);
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid HTTP header name', path: [name] });
      continue;
    }

    const normalizedName = name.toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      context.addIssue({ code: 'custom', message: 'duplicate HTTP header name', path: [name] });
    } else {
      normalizedNames.add(normalizedName);
    }

    try {
      new Headers([[name, value]]);
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid HTTP header value', path: [name] });
    }
  }
});
const StartupPolicySchema = z.enum(['automatic', 'authentication-required']).optional();

const StdioServerSchema = z.strictObject({
  args: z.array(SpawnStringSchema).optional(),
  command: NonEmptySpawnStringSchema,
  enabledTools: z.array(z.string()).optional(),
  env: EnvironmentSchema.optional(),
  extensions: McpExtensionEnablementSchema.optional(),
  name: ConfiguredMcpServerIdSchema,
  protocol: McpProtocolEnum.optional(),
  startup: StartupPolicySchema,
  transport: z.literal('stdio'),
});

const HttpServerSchema = z.strictObject({
  auth: McpConfiguredAuthSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  extensions: McpExtensionEnablementSchema.optional(),
  headers: HeadersSchema.optional(),
  name: ConfiguredMcpServerIdSchema,
  protocol: McpProtocolEnum.optional(),
  startup: StartupPolicySchema,
  url: HttpUrlSchema,
});

const McpServerInputSchema = z
  .discriminatedUnion('transport', [
    StdioServerSchema,
    HttpServerSchema.extend({ transport: z.literal('streamable-http') }),
    HttpServerSchema.extend({ transport: z.literal('sse') }),
  ])
  .superRefine((server, context) => {
    if (server.transport === 'sse' && server.protocol && server.protocol !== 'legacy') {
      context.addIssue({
        code: 'custom',
        message: 'legacy SSE transport requires protocol "legacy"',
        path: ['protocol'],
      });
    }
    if (
      server.transport === 'stdio' &&
      resolveMcpStartupPolicy(server) === 'authentication-required' &&
      server.protocol === 'auto'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'user-paced stdio authorization requires protocol "legacy"',
        path: ['protocol'],
      });
    }
    if (
      server.transport !== 'stdio' &&
      server.auth !== undefined &&
      server.auth.type !== 'none' &&
      Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'auth mode must not be combined with an Authorization header',
        path: ['auth'],
      });
    }
    if (
      server.transport !== 'stdio' &&
      server.auth?.type === 'oauth-user' &&
      server.startup === 'automatic'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OAuth user authentication requires startup "authentication-required"',
        path: ['startup'],
      });
    }
  });

export const McpServerSchema = McpServerInputSchema.transform((server) => ({
  ...server,
  protocol: server.protocol ?? ('legacy' as const),
  startup: resolveMcpStartupPolicy(server),
}));

const McpConfigInputSchema = z
  .strictObject({ servers: z.array(McpServerInputSchema) })
  .superRefine((config, context) => {
    const serverNames = new Set<string>();
    for (const [index, server] of config.servers.entries()) {
      if (serverNames.has(server.name)) {
        context.addIssue({
          code: 'custom',
          message: 'duplicate server name',
          path: ['servers', index, 'name'],
        });
        continue;
      }
      serverNames.add(server.name);
    }
  });

export const McpConfigSchema = McpConfigInputSchema.transform((config) => ({
  servers: config.servers.map((server) => ({
    ...server,
    protocol: server.protocol ?? ('legacy' as const),
    startup: resolveMcpStartupPolicy(server),
  })),
}));

export type McpServerInput = z.input<typeof McpServerSchema>;
export type McpServer = z.output<typeof McpServerSchema>;
export type ResolvedMcpServer = McpServer;
export type McpConfigInput = z.input<typeof McpConfigSchema>;
export type McpConfig = z.output<typeof McpConfigSchema>;
export type ResolvedMcpConfig = McpConfig;

export interface McpProtocolMigration {
  code: 'mcp_protocol_defaulted_to_legacy';
  serverIndex: number;
  serverName: string;
}

function toValidationIssues(error: z.ZodError): McpConfigValidationIssue[] {
  return error.issues.map((issue) => ({
    message: issue.message,
    path: issue.path.join('.'),
  }));
}

export function parseMcpServerValue(value: unknown): ResolvedMcpServer {
  const parsed = McpServerSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpConfigValidationError(toValidationIssues(parsed.error));
  }
  return parsed.data;
}

export function parseMcpConfigValue(value: unknown): {
  config: ResolvedMcpConfig;
  migrations: McpProtocolMigration[];
} {
  const parsed = McpConfigInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpConfigValidationError(toValidationIssues(parsed.error));
  }
  const migrations = parsed.data.servers.flatMap((server, serverIndex) =>
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
  return { config: McpConfigSchema.parse(parsed.data), migrations };
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
