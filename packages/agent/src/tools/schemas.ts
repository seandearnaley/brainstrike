import { z } from 'zod';

const FilesystemListInput = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strict();

export type FilesystemListInput = z.infer<typeof FilesystemListInput>;

export function validateToolInput(
  name: string,
  params: Record<string, unknown> | undefined
): { ok: true; data: unknown } | { ok: false; issues: string[] } {
  try {
    switch (name) {
      case 'filesystem.list': {
        const res = FilesystemListInput.safeParse(params ?? {});
        if (!res.success)
          return {
            ok: false,
            issues: res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
          };
        return { ok: true, data: res.data };
      }
      case 'web.echo': {
        const EchoInput = z.object({ text: z.string().min(1) }).strict();
        const res = EchoInput.safeParse(params ?? {});
        if (!res.success)
          return {
            ok: false,
            issues: res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`),
          };
        return { ok: true, data: res.data };
      }
      default:
        // Unknown tool: accept pass-through to let host handle or fail later
        return { ok: true, data: params ?? {} };
    }
  } catch (err) {
    return { ok: false, issues: [err instanceof Error ? err.message : String(err)] };
  }
}
