import { z } from 'zod';

export const McpTransportEnum = z.enum(['stdio', 'streamable-http', 'sse']);

const StdioSchema = z.object({
  args: z.array(z.string()).optional(),
  command: z.string().min(1),
  enabledTools: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  transport: z.literal('stdio'),
});

const HttpServerSchema = z.object({
  enabledTools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  url: z.string().url(),
});

const StreamableHttpSchema = HttpServerSchema.extend({
  transport: z.literal('streamable-http'),
});

const SseSchema = HttpServerSchema.extend({
  transport: z.literal('sse'),
});

export const McpServerSchema = z.discriminatedUnion('transport', [
  StdioSchema,
  StreamableHttpSchema,
  SseSchema,
]);

export const McpConfigSchema = z
  .object({
    servers: z.array(McpServerSchema).min(1),
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

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

function formatZodIssue(issue: z.ZodIssue): { path: string; message: string } {
  const path = Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path);
  return { message: issue.message, path };
}

export function parseMcpConfig(jsonText: string): McpConfig {
  const raw = JSON.parse(jsonText) as unknown;
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => formatZodIssue(issue));
    throw new Error(JSON.stringify({ code: 'invalid_mcp_config', issues }));
  }
  return parsed.data;
}
