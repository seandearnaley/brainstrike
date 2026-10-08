import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { HostRunSnapshotSchema, McpToolAuthoritySchema } from '@brainstrike/agent-host/protocol';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { PERMISSION_DECISIONS, TOOL_RISK_CATEGORIES } from '@brainstrike/assistant-contract';
import { z } from 'zod';

const Id = z.string().min(1);
const Decision = z.enum(PERMISSION_DECISIONS);
export const PlatformRunRequestSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()).optional(),
  modelId: Id,
  prompt: z.string().optional(),
  snapshot: HostRunSnapshotSchema.optional(),
  threadId: Id,
});
export const PlatformToolRequestSchema = z.strictObject({
  input: z.json(),
  resumeData: z.json().optional(),
  runId: Id,
  threadId: Id,
  toolCallId: Id,
  toolId: Id,
});
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
const NullableTokens = z.number().nonnegative().nullable();
export const PlatformWorkspaceContextSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      approxTokens: NullableTokens,
      outputApproxTokens: NullableTokens,
      path: Id,
      ranges: z.array(
        z.strictObject({
          approxTokens: NullableTokens.optional(),
          endLine: z.number().int().positive(),
          isActive: z.boolean(),
          startLine: z.number().int().positive(),
        })
      ),
      rootDisplayName: z.string().optional(),
      rootId: Id.optional(),
    })
  ),
  includeProjectTree: z.boolean(),
  projectTreeApproxTokens: NullableTokens,
  projectTreeTokenCountLoading: z.boolean(),
  selectedOutputApproxTokens: NullableTokens,
  selectedSourceApproxTokens: NullableTokens,
  tokenBudget: z.number().positive().optional(),
});
/** Existing UI preference owners supply only non-secret intent; roots remain Main-owned. */
export const PlatformClientConfigurationSchema = z.strictObject({
  agentLoop: z
    .strictObject({
      inputTokenLimit: z.number().int().positive().optional(),
      maxSteps: z.number().int().positive().optional(),
    })
    .optional(),
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
  workspaceContext: PlatformWorkspaceContextSchema.optional(),
  workspaceInstructionsPreference: z.strictObject({
    masterEnabled: z.boolean(),
    oversizedOptInByRootId: z.record(z.string(), z.boolean()),
  }),
});
export const PlatformSelectionSchema = z.strictObject({
  configuration: PlatformModelConfigurationSchema,
  contextWindow: z.number().int().positive(),
  durableConfiguration: z.record(z.string(), z.json()),
  inputTokenLimit: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  memory: z.strictObject({
    options: PlatformMemoryOptionsSchema,
    settings: PlatformMemorySettingsSchema,
  }),
  resourceId: Id,
  system: z.string().optional(),
  tools: z.record(
    z.string(),
    z.strictObject({
      description: z.string(),
      identity: Id,
      inputSchema: z.record(z.string(), z.json()),
      interaction: z
        .strictObject({
          kind: z.enum(['question', 'plan']),
          resumeSchema: z.record(z.string(), z.json()),
        })
        .optional(),
      mcpAuthority: McpToolAuthoritySchema.optional(),
      mcpBinding: z
        .strictObject({ configuredServerId: Id, generation: z.number().int().positive().safe() })
        .optional(),
      permissionToolId: Id,
      risk: z.enum(TOOL_RISK_CATEGORIES),
      strict: z.boolean().optional(),
    })
  ),
  toolTimeoutMs: z.number().positive(),
});
export const PlatformProgressSchema = z.strictObject({
  chunk: z.json(),
  runId: Id,
  threadId: Id,
  toolCallId: Id,
});
/** Confidential, private launcher channel only; absent from client protocol and log. */
export const PlatformAuthSchema = z.union([
  z.strictObject({ kind: z.literal('custom_fetch') }),
  z.strictObject({ apiKey: z.string(), kind: z.literal('api_key') }),
  z.strictObject({ apiKey: z.string(), kind: z.literal('aws'), region: Id }),
  z.strictObject({
    identity: z.strictObject({
      accessKeyId: Id,
      accountId: z.string().optional(),
      credentialScope: z.string().optional(),
      expiration: z.iso.datetime().optional(),
      secretAccessKey: Id,
      sessionToken: z.string().optional(),
    }),
    kind: z.literal('aws'),
    region: Id,
  }),
  z.null(),
]);
export type PlatformSelection = z.output<typeof PlatformSelectionSchema>;
