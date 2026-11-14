import { CliWorkspaceSelectionSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  ContextCompactionTokenCapSchema,
  PERMISSION_DECISIONS,
  type PermissionToolGateSnapshot,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { omitUndefinedOptional } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

// Shared by renderer Send capture and Main admission; native platform owners stay in platform-wire.
const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Decision = Schema.Literals(PERMISSION_DECISIONS);
const PlatformPolicySchema = Schema.Struct({
  autoReview: Schema.optional(Schema.Struct({ model: Id })),
  perToolOverrides: Schema.optional(Schema.Record(Schema.String, Decision)),
  policies: Schema.Struct({ edit: Decision, execute: Decision, mcp: Decision, read: Decision }),
  sessionGrants: Schema.optional(
    Schema.mutable(Schema.Array(Schema.Literals(TOOL_RISK_CATEGORIES)))
  ),
  yolo: Schema.Boolean,
});
export function platformPermissionPolicy(input: unknown): PermissionToolGateSnapshot {
  const policy = Schema.decodeUnknownSync(PlatformPolicySchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
  return {
    ...(policy.autoReview ? { autoReview: policy.autoReview } : {}),
    policies: policy.policies,
    yolo: policy.yolo,
    ...(policy.perToolOverrides ? { perToolOverrides: policy.perToolOverrides } : {}),
    ...(policy.sessionGrants ? { sessionGrants: policy.sessionGrants } : {}),
  };
}
export const PlatformModelConfigurationSchema = Schema.Struct({
  model: Id,
  modelSettings: Schema.optional(
    Schema.Struct({
      frequencyPenalty: omitUndefinedOptional(Schema.Finite),
      maxOutputTokens: omitUndefinedOptional(Schema.Finite),
      presencePenalty: omitUndefinedOptional(Schema.Finite),
      temperature: omitUndefinedOptional(Schema.Finite),
      topP: omitUndefinedOptional(Schema.Finite),
    })
  ),
  provider: Id,
  providerOptions: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.MutableJson))
  ),
});
/** BST-1932: the renderer's subagent preferences, captured with each run's input. */
const PlatformSubagentsIntentSchema = Schema.Struct({
  delegationEnabled: Schema.Boolean,
  disabledPersonaIds: Schema.mutable(Schema.Array(Id)),
  /** ADR-0037: the `provider::model` IDs a delegation may name. */
  models: Schema.optional(Schema.mutable(Schema.Array(Id))),
  settings: runtimeSubagentSettingsSchema,
});
/** Existing UI preference owners supply only non-secret intent; roots remain Main-owned. */
export const PlatformClientConfigurationSchema = Schema.Struct({
  agentLoop: Schema.optional(
    Schema.Struct({
      /** BST-2539: the person's compaction cap; absent, the admission uses the default. */
      compactionTokenCap: Schema.optional(ContextCompactionTokenCapSchema),
      inputTokenLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      maxSteps: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    })
  ),
  cliWorkspace: Schema.optional(CliWorkspaceSelectionSchema),
  enabledNativeToolIds: Schema.mutable(Schema.Array(Id)),
  modelConfiguration: PlatformModelConfigurationSchema,
  permissionPolicy: PlatformPolicySchema,
  selectionFolderId: Schema.optional(Id),
  skillsPreference: Schema.optional(
    Schema.Struct({
      disabledSkillKeys: Schema.mutable(Schema.Array(Schema.String)),
      masterEnabled: Schema.Boolean,
    })
  ),
  subagents: Schema.optional(PlatformSubagentsIntentSchema),
  workspaceContext: Schema.optional(Schema.MutableJson),
  workspaceInstructionsPreference: Schema.Struct({
    masterEnabled: Schema.Boolean,
    oversizedOptInByRootId: Schema.Record(Schema.String, Schema.Boolean),
  }),
});
