import { Schema } from 'effect';

/**
 * A workspace root by its absolute path. Its project hooks are
 * `<path>/.brainstrike/hooks.json`, and their approval is recorded for the
 * root's repository: a managed worktree shares its repository's approvals.
 */
const HookRoot = { path: Schema.String.check(Schema.isMinCodePoints(1)) };
/** The SHA-256 of a hooks file's raw bytes. */
export const HostHookSha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

/** Host-owned project hook approval: only the host writes it, and only at the hash a reviewer saw. */
export const HOOK_TRUST_METHOD_SCHEMAS = {
  /**
   * Approve a root's project hooks at the hash its reviewer saw. The host
   * re-hashes the file and refuses a mismatch; a later edit needs a new approval.
   */
  'hooks/trust': Schema.Struct({ ...HookRoot, sha256: HostHookSha256Schema }),
  'hooks/trust/read': Schema.Struct(HookRoot),
  /** Revoke every version approved for the root's repository. */
  'hooks/untrust': Schema.Struct(HookRoot),
} as const;
export const HOOK_TRUST_RESULT_SCHEMAS = {
  'hooks/trust': Schema.Struct({ trusted: Schema.Literal(true) }),
  /**
   * The hash the root's hooks may run at: its file's own hash when those bytes
   * are approved, otherwise the newest approved hash (the file has changed
   * since), and null when nothing is approved.
   */
  'hooks/trust/read': Schema.Struct({ approvedSha256: Schema.NullOr(HostHookSha256Schema) }),
  /** Whether an approval was revoked; false when the root's repository had none. */
  'hooks/untrust': Schema.Struct({ untrusted: Schema.Boolean }),
} as const;
