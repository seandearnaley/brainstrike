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
  /** The MCP server configuration this host composes, as the desktop's config JSON. */
  mcpConfig: z
    .strictObject({
      path: z.string().refine(isAbsolute, 'An explicit absolute MCP config file is required'),
    })
    .optional(),
});
export type HostPlatformLaunchOptions = z.infer<typeof HostPlatformLaunchOptionsSchema>;
