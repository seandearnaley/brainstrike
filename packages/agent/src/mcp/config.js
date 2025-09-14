Object.defineProperty(exports, '__esModule', { value: true });
exports.McpConfigSchema = exports.McpServerSchema = exports.McpTransportEnum = void 0;
exports.parseMcpConfig = parseMcpConfig;
const zod1 = require('zod');
exports.McpTransportEnum = zod1.z.enum(['stdio', 'sse']);
const StdioSchema = zod1.z.object({
  transport: zod1.z.literal('stdio'),
  name: zod1.z.string().min(1),
  command: zod1.z.string().min(1),
  args: zod1.z.array(zod1.z.string()).optional(),
  env: zod1.z.record(zod1.z.string()).optional(),
});
const SseSchema = zod1.z.object({
  transport: zod1.z.literal('sse'),
  name: zod1.z.string().min(1),
  url: zod1.z.string().url(),
  headers: zod1.z.record(zod1.z.string()).optional(),
});
exports.McpServerSchema = zod1.z.discriminatedUnion('transport', [StdioSchema, SseSchema]);
exports.McpConfigSchema = zod1.z.object({
  servers: zod1.z.array(exports.McpServerSchema).min(1),
});
function parseMcpConfig(jsonText) {
  const raw = JSON.parse(jsonText);
  const parsed = exports.McpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new Error(JSON.stringify({ code: 'invalid_mcp_config', issues }));
  }
  return parsed.data;
}
