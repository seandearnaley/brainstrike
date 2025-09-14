import { z } from 'zod';

const FilesystemListInput = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strict();

export type FilesystemListInput = z.infer<typeof FilesystemListInput>;

const FilesystemReadInput = z
  .object({
    path: z.string().min(1),
    encoding: z.enum(['utf8', 'base64']).optional(),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .optional(),
  })
  .strict();

export type FilesystemReadInput = z.infer<typeof FilesystemReadInput>;

const FilesystemSearchInput = z
  .object({
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    maxResults: z.number().int().positive().max(5000).optional(),
    maxDepth: z.number().int().positive().max(10).optional(),
  })
  .strict();

export type FilesystemSearchInput = z.infer<typeof FilesystemSearchInput>;

const EchoInput = z.object({ text: z.string().min(1) }).strict();

const schemaMap: Record<string, z.ZodSchema> = {
  'filesystem.list': FilesystemListInput,
  'filesystem.read': FilesystemReadInput,
  'filesystem.search': FilesystemSearchInput,
  'web.echo': EchoInput,
};

function parseWithSchema(
  schema: z.ZodSchema,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  const res = schema.safeParse(params ?? {});
  if (!res.success) {
    return {
      ok: false,
      issues: res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
    };
  }
  return { ok: true, data: res.data };
}

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
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
