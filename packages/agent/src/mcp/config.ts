import {
  ConfiguredMcpServerIdSchema,
  McpConfiguredAuthSchema,
} from '@brainstrike/assistant-contract';
import { z } from 'zod';

export const McpTransportEnum = z.enum(['stdio', 'streamable-http', 'sse']);
export const McpProtocolEnum = z.enum(['legacy', 'auto', '2026-07-28']);
export type McpProtocol = z.infer<typeof McpProtocolEnum>;
export function toMcpVersionNegotiation(protocol: McpProtocol): {
  mode: 'auto' | 'legacy' | { pin: '2026-07-28' };
} {
  if (protocol === '2026-07-28') {
    return { mode: { pin: protocol } };
  }
  return { mode: protocol };
}

const ProtocolPolicySchema = {
  protocol: McpProtocolEnum.optional(),
};
const StartupPolicySchema = z.enum(['automatic', 'authentication-required']).optional();

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

const StdioSchema = z.object({
  args: z.array(z.string()).optional(),
  auth: z.never().optional(),
  command: z.string().min(1),
  enabledTools: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: ConfiguredMcpServerIdSchema,
  ...ProtocolPolicySchema,
  startup: StartupPolicySchema,
  transport: z.literal('stdio'),
});

const HttpServerSchema = z.object({
  auth: McpConfiguredAuthSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  name: ConfiguredMcpServerIdSchema,
  ...ProtocolPolicySchema,
  startup: StartupPolicySchema,
  url: z.string().url(),
});

const StreamableHttpSchema = HttpServerSchema.extend({
  transport: z.literal('streamable-http'),
});

const SseSchema = HttpServerSchema.extend({
  transport: z.literal('sse'),
});

const McpServerInputSchema = z
  .discriminatedUnion('transport', [StdioSchema, StreamableHttpSchema, SseSchema])
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
    if (server.transport !== 'stdio' && server.auth?.type === 'bearer') {
      context.addIssue({
        code: 'custom',
        message: 'MCP bearer authentication requires a production credential resolver',
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
  .object({
    servers: z.array(McpServerInputSchema).min(1),
  })
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

function formatZodIssue(issue: z.ZodIssue): { path: string; message: string } {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  return { message: issue.message, path };
}

export function parseMcpConfigWithMigrations(jsonText: string): {
  config: ResolvedMcpConfig;
  migrations: McpProtocolMigration[];
} {
  const raw = JSON.parse(jsonText) as unknown;
  const parsed = McpConfigInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => formatZodIssue(issue));
    throw new Error(JSON.stringify({ code: 'invalid_mcp_config', issues }));
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

export function parseMcpConfig(jsonText: string): ResolvedMcpConfig {
  return parseMcpConfigWithMigrations(jsonText).config;
}
