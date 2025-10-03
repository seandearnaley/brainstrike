import { z } from 'zod';

export const McpTransportEnum = z.enum(['stdio', 'sse']);

const StdioSchema = z.object({
  transport: z.literal('stdio'),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
});

const SseSchema = z.object({
  transport: z.literal('sse'),
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
});

export const McpServerSchema = z.discriminatedUnion('transport', [StdioSchema, SseSchema]);

export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).min(1),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;

export function parseMcpConfig(jsonText: string): McpConfig {
  const raw = JSON.parse(jsonText) as unknown;
  const parsed = McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new Error(JSON.stringify({ code: 'invalid_mcp_config', issues }));
  }
  return parsed.data;
}
