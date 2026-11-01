import { Schema } from 'effect';

/** A workspace root by its durable ID: the desktop's DB `roots.id`. */
const HookRoot = { rootId: Schema.String.check(Schema.isMinCodePoints(1)) };
/**
 * A root's trusted project hooks: its absolute path and the SHA-256 of
 * `<path>/.brainstrike/hooks.json`'s raw bytes. The host is the only writer.
 */
export const HostHookTrustSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinCodePoints(1)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type HostHookTrust = (typeof HostHookTrustSchema)['Type'];

/** Host-owned project hook trust: only the host writes it, and only at the hash a reviewer saw. */
export const HOOK_TRUST_METHOD_SCHEMAS = {
  /**
   * Trust a root's project hooks at the hash its reviewer saw. The host
   * re-hashes the file and refuses a mismatch; a later edit needs a new trust.
   */
  'hooks/trust': Schema.Struct({ ...HookRoot, ...HostHookTrustSchema.fields }),
  'hooks/trust/read': Schema.Struct(HookRoot),
  /** Revoke a root's trust; removing the root revokes it too. */
  'hooks/untrust': Schema.Struct(HookRoot),
} as const;
export const HOOK_TRUST_RESULT_SCHEMAS = {
  'hooks/trust': Schema.Struct({ trusted: Schema.Literal(true) }),
  'hooks/trust/read': Schema.Struct({ trust: Schema.NullOr(HostHookTrustSchema) }),
  /** Whether a trust was revoked; false when the root had none. */
  'hooks/untrust': Schema.Struct({ untrusted: Schema.Boolean }),
} as const;
