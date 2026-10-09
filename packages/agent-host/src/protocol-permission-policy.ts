import { PERMISSION_DECISIONS } from '@brainstrike/assistant-contract';
import { z } from 'zod';

const Decision = z.enum(PERMISSION_DECISIONS);

/**
 * The permission policy the desktop user saved (BST-1930 stage e): whether it
 * is enforced, each risk category's decision, per-tool overrides and the
 * allow-everything toggle. Session grants are not saved; Core keeps a run
 * tree's own.
 */
export const HostPermissionPolicySchema = z.strictObject({
  enforce: z.boolean(),
  perToolOverrides: z.record(z.string().min(1), Decision),
  policies: z.strictObject({ edit: Decision, execute: Decision, mcp: Decision, read: Decision }),
  yolo: z.boolean(),
});
export type HostPermissionPolicy = z.output<typeof HostPermissionPolicySchema>;

export const PERMISSION_POLICY_METHOD_SCHEMAS = {
  'permissions/policy/read': z.strictObject({}),
  /** A null policy clears the saved one: the shipped default applies again. */
  'permissions/policy/write': z.strictObject({ policy: HostPermissionPolicySchema.nullable() }),
} as const;

export const PERMISSION_POLICY_RESULT_SCHEMAS = {
  'permissions/policy/read': z.strictObject({ policy: HostPermissionPolicySchema.nullable() }),
  'permissions/policy/write': z.strictObject({ policy: HostPermissionPolicySchema.nullable() }),
} as const;
