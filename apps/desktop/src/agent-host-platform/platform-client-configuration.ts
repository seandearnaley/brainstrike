import { CliWorkspaceSelectionSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import type { RuntimeData } from '@brainstrike/assistant-contract';
import {
  PERMISSION_DECISIONS,
  type PermissionToolGateSnapshot,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { z } from 'zod';

// Shared by renderer Send capture and Main admission; native platform owners stay in platform-wire.
const Id = z.string().min(1);
const Decision = z.enum(PERMISSION_DECISIONS);
export const PlatformPolicySchema = z.strictObject({
  perToolOverrides: z.record(z.string(), Decision).optional(),
  policies: z.strictObject({ edit: Decision, execute: Decision, mcp: Decision, read: Decision }),
  sessionGrants: z.array(z.enum(TOOL_RISK_CATEGORIES)).optional(),
  yolo: z.boolean(),
});
export function platformPermissionPolicy(input: unknown): PermissionToolGateSnapshot {
  const policy = PlatformPolicySchema.parse(input);
  return {
    policies: policy.policies,
    yolo: policy.yolo,
    ...(policy.perToolOverrides ? { perToolOverrides: policy.perToolOverrides } : {}),
    ...(policy.sessionGrants ? { sessionGrants: policy.sessionGrants } : {}),
  };
}
export const PlatformModelConfigurationSchema = z.strictObject({
  model: Id,
  modelSettings: z
    .strictObject({
      frequencyPenalty: z.number().optional(),
      maxOutputTokens: z.number().optional(),
      presencePenalty: z.number().optional(),
      temperature: z.number().optional(),
      topP: z.number().optional(),
    })
    .transform(
      (settings): NonNullable<RuntimeData['modelSettings']> => ({
        ...(settings.frequencyPenalty === undefined
          ? {}
          : { frequencyPenalty: settings.frequencyPenalty }),
        ...(settings.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: settings.maxOutputTokens }),
        ...(settings.presencePenalty === undefined
          ? {}
          : { presencePenalty: settings.presencePenalty }),
        ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
        ...(settings.topP === undefined ? {} : { topP: settings.topP }),
      })
    )
    .optional(),
  provider: Id,
  providerOptions: z.record(z.string(), z.record(z.string(), z.json())).optional(),
});
export const PlatformMemoryOptionsSchema = z.strictObject({
  lastMessages: z.union([z.literal(false), z.number().int().positive()]),
  workingMemory: z.strictObject({
    enabled: z.boolean(),
    scope: z.enum(['thread', 'resource']),
    template: z.string(),
  }),
});
export const PlatformMemorySettingsSchema = z.strictObject({
  observationalMemory: z.strictObject({
    enabled: z.boolean(),
    messageTokens: z.number().positive(),
    modelTarget: Id,
    observationTokens: z.number().positive(),
    retrievalMode: z.enum(['off', 'messages', 'vector']),
    scope: z.enum(['thread', 'resource']),
  }),
  semanticRecall: z.strictObject({
    embeddingModelTarget: z.string().nullable(),
    enabled: z.boolean(),
    messageRange: z.number().int().nonnegative(),
    scope: z.enum(['thread', 'resource']),
    topK: z.number().int().positive(),
  }),
});
/** BST-1932: the renderer's subagent preferences, captured with each run's input. */
export const PlatformSubagentsIntentSchema = z.strictObject({
  delegationEnabled: z.boolean(),
  disabledPersonaIds: z.array(Id),
  settings: runtimeSubagentSettingsSchema,
});
export type PlatformSubagentsIntent = z.infer<typeof PlatformSubagentsIntentSchema>;
/** Existing UI preference owners supply only non-secret intent; roots remain Main-owned. */
export const PlatformClientConfigurationSchema = z.strictObject({
  agentLoop: z
    .strictObject({
      inputTokenLimit: z.number().int().positive().optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
  cliWorkspace: CliWorkspaceSelectionSchema.optional(),
  enabledNativeToolIds: z.array(Id),
  memoryOptions: PlatformMemoryOptionsSchema,
  memorySettings: PlatformMemorySettingsSchema,
  modelConfiguration: PlatformModelConfigurationSchema,
  permissionPolicy: PlatformPolicySchema,
  selectionFolderId: Id.optional(),
  skillsPreference: z
    .strictObject({
      disabledSkillKeys: z.array(z.string()),
      masterEnabled: z.boolean(),
    })
    .optional(),
  subagents: PlatformSubagentsIntentSchema.optional(),
  /**
   * Checked files as context, retired (BST-2019). A run committed before then
   * carries it in its captured intent; it is accepted so that run can still be
   * recovered, and read as nothing.
   */
  workspaceContext: z.json().optional(),
  workspaceInstructionsPreference: z.strictObject({
    masterEnabled: z.boolean(),
    oversizedOptInByRootId: z.record(z.string(), z.boolean()),
  }),
});
