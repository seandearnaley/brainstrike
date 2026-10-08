import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Trusted launch selection only; values and credentials stay in the adapter. */
export const HostPlatformLaunchOptionsSchema = z.strictObject({
  credentialStore: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('keyring'), service: z.string().min(1) }),
      z.strictObject({
        kind: z.literal('file'),
        path: z.string().refine(isAbsolute, 'An explicit absolute credential file is required'),
      }),
    ])
    .optional(),
  /**
   * A standalone host's workspace roots (`--workspace`, cwd when omitted). The
   * launch option owns their identity; a profile-backed host never takes them.
   */
  workspaceRoots: z
    .array(z.string().refine(isAbsolute, 'Workspace roots must be absolute paths'))
    .min(1)
    .optional(),
});
export type HostPlatformLaunchOptions = z.infer<typeof HostPlatformLaunchOptionsSchema>;
