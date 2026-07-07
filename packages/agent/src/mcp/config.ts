import { z } from 'zod';

export const McpTransportEnum = z.enum(['stdio', 'sse']);

const StdioSchema = z.object({
  args: z.array(z.string()).optional(),
  command: z.string().min(1),
  enabledTools: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  transport: z.literal('stdio'),
});

const SseSchema = z.object({
  enabledTools: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  name: z.string().min(1),
  transport: z.literal('sse'),
  url: z.string().url(),
});

export const McpServerSchema = z.discriminatedUnion('transport', [StdioSchema, SseSchema]);

export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).min(1),
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
