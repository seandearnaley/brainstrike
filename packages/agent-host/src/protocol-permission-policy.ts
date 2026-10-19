import { PERMISSION_DECISIONS } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';

const Decision = Schema.Literals(PERMISSION_DECISIONS);
/**
 * The permission policy the desktop user saved (BST-1930 stage e): whether it
 * is enforced, each risk category's decision, per-tool overrides and the
 * allow-everything toggle. Session grants are not saved; Core keeps a run
 * tree's own.
 */
export const HostPermissionPolicySchema = Schema.Struct({
  enforce: Schema.Boolean,
  perToolOverrides: Schema.Record(Schema.String.check(Schema.isMinCodePoints(1)), Decision),
  policies: Schema.Struct({ edit: Decision, execute: Decision, mcp: Decision, read: Decision }),
  yolo: Schema.Boolean,
});
export type HostPermissionPolicy = (typeof HostPermissionPolicySchema)['Type'];
/** A web origin exactly as `URL.origin` writes it: http(s), host and any explicit port. */
export const HostBrowserOriginSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) {
      return 'Expected an http(s) origin';
    }
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
      ? undefined
      : 'Expected an http(s) origin';
  })
);
/**
 * BST-1178: what a person saved for a browser origin the agent opens. Allow
 * once is never saved; these answer every later call to the origin.
 */
export const HostBrowserOriginAnswerSchema = Schema.Literals(['allow', 'deny']);
export type HostBrowserOriginAnswer = (typeof HostBrowserOriginAnswerSchema)['Type'];
export const HostBrowserOriginAnswersSchema = Schema.Record(
  HostBrowserOriginSchema,
  HostBrowserOriginAnswerSchema
);
export type HostBrowserOriginAnswers = (typeof HostBrowserOriginAnswersSchema)['Type'];
/**
 * The answer to a `network` interaction: allow lets this one call reach its
 * requested domains or browser origin; deny settles it unrun (run_python's
 * `network_denied`). BST-1178: only a browser origin's consent may be
 * remembered, which saves the answer for every later call to that origin.
 */
export const HostNetworkConsentSchema = Schema.Struct({
  action: Schema.Literals(['allow', 'deny']),
  remember: Schema.optional(Schema.Literal(true)),
});
export const PERMISSION_POLICY_METHOD_SCHEMAS = {
  'permissions/origins/read': Schema.Record(Schema.String, Schema.Never),
  'permissions/origins/remove': Schema.Struct({ origin: HostBrowserOriginSchema }),
  'permissions/policy/read': Schema.Record(Schema.String, Schema.Never),
  /** A null policy clears the saved one: the shipped default applies again. */
  'permissions/policy/write': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
} as const;
export const PERMISSION_POLICY_RESULT_SCHEMAS = {
  'permissions/origins/read': Schema.Struct({ origins: HostBrowserOriginAnswersSchema }),
  'permissions/origins/remove': Schema.Struct({ removed: Schema.Boolean }),
  'permissions/policy/read': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
  'permissions/policy/write': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
} as const;
