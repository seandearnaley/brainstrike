import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** A disposable sign-in issuer: only a loopback HTTP origin is accepted. */
const LoopbackIssuer = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === value;
}, 'A test OAuth issuer must be a loopback http origin');

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
   * Env files the launching shell rejected. Their messages name the file and
   * line only, never a value; provider status reports them and gates on them.
   */
  envFileFailures: z
    .array(
      z.strictObject({
        code: z.enum(['env_file_invalid', 'env_file_unreadable']),
        file: z.enum(['dev', 'dev-local', 'user-data']),
        message: z.string().min(1),
      })
    )
    .optional(),
  /**
   * The launching desktop still holds a retired encrypted store it will import
   * over `auth/import-legacy` once this host is ready; credential use waits
   * for that import to settle.
   */
  legacyImportPending: z.literal(true).optional(),
  /** The MCP server configuration this host composes, as the desktop's config JSON. */
  mcpConfig: z
    .strictObject({
      path: z.string().refine(isAbsolute, 'An explicit absolute MCP config file is required'),
    })
    .optional(),
  /**
   * The isolated E2E launch's stand-in for the OpenAI Codex sign-in issuer,
   * inside its provider egress boundary. A shipped launch never sets it.
   */
  openAiCodexIssuer: LoopbackIssuer.optional(),
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
export type HostEnvFileFailure = NonNullable<HostPlatformLaunchOptions['envFileFailures']>[number];
