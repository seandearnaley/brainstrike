import { ConfiguredMcpServerIdSchema } from '@brainstrike/assistant-contract';
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
  const executable = command.replaceAll('\\', '/').split('/').at(-1);
  return (
    executable === 'mcp-remote' || args?.some((argument) => argument === 'mcp-remote') === true
  );
}

function resolveStartupPolicy(server: {
  args?: readonly string[] | undefined;
  command?: string | undefined;
  startup?: 'automatic' | 'authentication-required' | undefined;
  transport: string;
}): 'automatic' | 'authentication-required' {
  if (
    server.transport === 'stdio' &&
    server.command !== undefined &&
    isInteractiveMcpStdioServer(server.command, server.args)
  ) {
    return 'authentication-required';
  }
  return server.startup ?? 'automatic';
}

const StdioSchema = z.object({
  args: z.array(z.string()).optional(),
  command: z.string().min(1),
  enabledTools: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: ConfiguredMcpServerIdSchema,
  ...ProtocolPolicySchema,
  startup: StartupPolicySchema,
  transport: z.literal('stdio'),
});

const HttpServerSchema = z.object({
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
  });

export const McpServerSchema = McpServerInputSchema.transform((server) => ({
  ...server,
  protocol: server.protocol ?? ('legacy' as const),
  startup: resolveStartupPolicy(server),
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
    startup: resolveStartupPolicy(server),
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
