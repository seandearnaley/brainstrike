Object.defineProperty(exports, '__esModule', { value: true });
exports.validateToolInput = validateToolInput;
const zod1 = require('zod');
const FilesystemListInput = zod1.z
  .object({
    path: zod1.z.string().min(1).optional(),
  })
  .strict();
const FilesystemReadInput = zod1.z
  .object({
    path: zod1.z.string().min(1),
    encoding: zod1.z.enum(['utf8', 'base64']).optional(),
    maxBytes: zod1.z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .optional(),
  })
  .strict();
const FilesystemSearchInput = zod1.z
  .object({
    query: zod1.z.string().min(1),
    path: zod1.z.string().min(1).optional(),
    maxResults: zod1.z.number().int().positive().max(5000).optional(),
    maxDepth: zod1.z.number().int().positive().max(10).optional(),
  })
  .strict();
const EchoInput = zod1.z.object({ text: zod1.z.string().min(1) }).strict();

const schemaMap = {
  'filesystem.list': FilesystemListInput,
  'filesystem.read': FilesystemReadInput,
  'filesystem.search': FilesystemSearchInput,
  'web.echo': EchoInput,
};

function parseWithSchema(schema, params) {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      ok: false,
      issues: res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
    };
  }
  return { ok: true, data: res.data };
}

function validateToolInput(name, params) {
  try {
    const schema = schemaMap[name];
    if (schema) {
      return parseWithSchema(schema, params);
    }
    // Unknown tool: accept pass-through to let host handle or fail later
    return { ok: true, data: params ?? {} };
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}
