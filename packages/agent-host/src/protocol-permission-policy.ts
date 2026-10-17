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
export const PERMISSION_POLICY_METHOD_SCHEMAS = {
  'permissions/policy/read': Schema.Record(Schema.String, Schema.Never),
  /** A null policy clears the saved one: the shipped default applies again. */
  'permissions/policy/write': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
} as const;
export const PERMISSION_POLICY_RESULT_SCHEMAS = {
  'permissions/policy/read': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
  'permissions/policy/write': Schema.Struct({ policy: Schema.NullOr(HostPermissionPolicySchema) }),
} as const;
