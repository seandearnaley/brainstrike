import { z } from 'zod';

export const McpTransportEnum = z.enum(['stdio', 'streamable-http', 'sse']);
export const McpProtocolEnum = z.enum(['legacy', 'auto', '2026-07-28']);

const ProtocolPolicySchema = {
  protocol: McpProtocolEnum.optional(),
  protocolSource: z.never().optional(),
};

const StdioSchema = z.object({
  args: z.array(z.string()).optional(),
  command: z.string().min(1),
  enabledTools: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  ...ProtocolPolicySchema,
  transport: z.literal('stdio'),
});

const HttpServerSchema = z.object({
  enabledTools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  ...ProtocolPolicySchema,
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
  servers: config.servers.map((server) => McpServerSchema.parse(server)),
}));

export type McpServer = z.input<typeof McpServerSchema>;
export type ResolvedMcpServer = z.output<typeof McpServerSchema>;
export type McpConfig = z.input<typeof McpConfigSchema>;
export type ResolvedMcpConfig = z.output<typeof McpConfigSchema>;
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
