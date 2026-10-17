import { CliWorkspaceSelectionSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
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
export const PlatformPolicySchema = Schema.Struct({
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
export const PlatformMemoryOptionsSchema = Schema.Struct({
  lastMessages: Schema.Union([Schema.Literal(false), Schema.Int.check(Schema.isGreaterThan(0))]),
  workingMemory: Schema.Struct({
    enabled: Schema.Boolean,
    scope: Schema.Literals(['thread', 'resource']),
    template: Schema.String,
  }),
});
export const PlatformMemorySettingsSchema = Schema.Struct({
  observationalMemory: Schema.Struct({
    enabled: Schema.Boolean,
    messageTokens: Schema.Finite.check(Schema.isGreaterThan(0)),
    modelTarget: Id,
    observationTokens: Schema.Finite.check(Schema.isGreaterThan(0)),
    retrievalMode: Schema.Literals(['off', 'messages', 'vector']),
    scope: Schema.Literals(['thread', 'resource']),
  }),
  semanticRecall: Schema.Struct({
    embeddingModelTarget: Schema.NullOr(Schema.String),
    enabled: Schema.Boolean,
    messageRange: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    scope: Schema.Literals(['thread', 'resource']),
    topK: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
});
/** BST-1932: the renderer's subagent preferences, captured with each run's input. */
export const PlatformSubagentsIntentSchema = Schema.Struct({
  delegationEnabled: Schema.Boolean,
  disabledPersonaIds: Schema.mutable(Schema.Array(Id)),
  settings: runtimeSubagentSettingsSchema,
});
export type PlatformSubagentsIntent = (typeof PlatformSubagentsIntentSchema)['Type'];
/** Existing UI preference owners supply only non-secret intent; roots remain Main-owned. */
export const PlatformClientConfigurationSchema = Schema.Struct({
  agentLoop: Schema.optional(
    Schema.Struct({
      inputTokenLimit: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      maxSteps: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    })
  ),
  cliWorkspace: Schema.optional(CliWorkspaceSelectionSchema),
  enabledNativeToolIds: Schema.mutable(Schema.Array(Id)),
  memoryOptions: PlatformMemoryOptionsSchema,
  memorySettings: PlatformMemorySettingsSchema,
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
