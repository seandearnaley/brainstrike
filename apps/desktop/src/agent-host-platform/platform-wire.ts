import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import { HostRunSnapshotSchema } from '@brainstrike/agent-host/protocol';
import {
  CliWorkspaceRootsSchema,
  CliWorkspaceSelectionSchema,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import { PERMISSION_DECISIONS, TOOL_RISK_CATEGORIES } from '@brainstrike/assistant-contract';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { z } from 'zod';

const Id = z.string().min(1);
const Decision = z.enum(PERMISSION_DECISIONS);
export const PlatformRunRequestSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()).optional(),
  modelId: Id,
  planMode: z.literal(true).optional(),
  prompt: z.string().optional(),
  snapshot: HostRunSnapshotSchema.optional(),
  threadId: Id,
  workspaceBinding: ThreadWorkspaceBindingSchema.optional(),
});
export const PlatformWorkspaceBindingRequestSchema = z.strictObject({
  binding: ThreadWorkspaceBindingSchema,
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
/** The indexer's one vector profile rule validates a recall embedding profile. */
const PlatformVectorProfileSchema = z.custom<VectorProfile>((input) => {
  try {
    vectorProfileHash(input);
    return true;
  } catch {
    return false;
  }
}, 'Memory vectors require a supported embedding profile');
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
  workspaceContext: PlatformWorkspaceContextSchema.optional(),
  workspaceInstructionsPreference: z.strictObject({
    masterEnabled: z.boolean(),
    oversizedOptInByRootId: z.record(z.string(), z.boolean()),
  }),
});
/** Admission data of the shared native tools; roots are revalidated per call via Main. */
export const PlatformNativeRuntimeSchema = z.strictObject({
  boundWorkspaceRootId: Id.optional(),
  provider: Id,
  /** The focused root's curated files, for the host's workspace-context reads. */
  selectionFilePaths: z.array(z.string()).optional(),
  selectionFolderId: Id.optional(),
  /** The request's curated context selection, as Main admitted it. */
  workspaceContext: PlatformWorkspaceContextSchema.optional(),
  workspaceRootPath: Id.optional(),
  workspaceRoots: CliWorkspaceRootsSchema,
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
    /** Recall/vector-OM embedding profile Main resolved; absent when memory uses no vectors. */
    vectorProfile: PlatformVectorProfileSchema.optional(),
  }),
  /** The admitted runtime the host's shared native tools execute against. */
  nativeRuntime: PlatformNativeRuntimeSchema,
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
      permissionToolId: Id,
      risk: z.enum(TOOL_RISK_CATEGORIES),
      strict: z.boolean().optional(),
    })
  ),
  toolTimeoutMs: z.number().positive(),
  workspace: z
    .strictObject({
      boundWorkspaceRootId: Id,
      roots: CliWorkspaceRootsSchema,
    })
    .optional(),
});
export const PlatformProgressSchema = z.strictObject({
  chunk: z.json(),
  runId: Id,
  threadId: Id,
  toolCallId: Id,
});
/**
 * ADR-0007: local generation runs in Main's hidden llm-host; the host only borrows it.
 * Exact optional fields match the public local client types.
 */
const LocalLlmToolCallSchema = z.strictObject({
  function: z.strictObject({ arguments: z.string(), name: z.string() }),
  id: z.string(),
  type: z.literal('function'),
});
export const PlatformLocalGenerationSchema = z.strictObject({
  messages: z.array(
    z.strictObject({
      content: z.string(),
      name: z.string().exactOptional(),
      role: z.enum(['system', 'user', 'assistant', 'developer', 'tool']),
      toolCallId: z.string().exactOptional(),
      toolCalls: z.array(LocalLlmToolCallSchema).exactOptional(),
      toolResponses: z
        .array(z.strictObject({ name: z.string(), response: z.json() }))
        .exactOptional(),
    })
  ),
  modelId: Id,
  options: z
    .strictObject({
      doSample: z.boolean().exactOptional(),
      maxNewTokens: z.number().int().positive().exactOptional(),
      repetitionPenalty: z.number().exactOptional(),
      temperature: z.number().exactOptional(),
      thinking: z.strictObject({ enabled: z.boolean().exactOptional() }).exactOptional(),
      tools: z
        .array(
          z.strictObject({
            function: z.strictObject({
              description: z.string(),
              name: z.string(),
              parameters: z.looseObject({ type: z.literal('object') }),
            }),
            type: z.literal('function'),
          })
        )
        .exactOptional(),
      topK: z.number().exactOptional(),
      topP: z.number().exactOptional(),
    })
    .exactOptional(),
  /** Correlates the generation's `platform/llm/progress` notifications. */
  requestId: z.uuid(),
  threadId: Id,
});
/** One cumulative progress snapshot of a borrowed local generation or warmup. */
export const PlatformLocalProgressSchema = z.strictObject({
  progress: z.strictObject({
    file: z.string().exactOptional(),
    kind: z.enum(['loading', 'reasoning', 'stage', 'text']),
    message: z.string().exactOptional(),
    progress: z.number().exactOptional(),
    reasoningText: z.string().exactOptional(),
    text: z.string().exactOptional(),
  }),
  requestId: z.uuid(),
});
export const PlatformLocalGenerationResultSchema = z.strictObject({
  finishReason: z.enum(['stop', 'length', 'tool_calls']),
  reasoningText: z.string().exactOptional(),
  text: z.string(),
  toolCalls: z.array(LocalLlmToolCallSchema).exactOptional(),
  usage: z.strictObject({
    completionTokens: z.number().nonnegative(),
    promptTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
});
export const PlatformLocalWarmupSchema = z.strictObject({
  modelId: Id,
  requestId: z.uuid(),
  threadId: Id,
});
export const PlatformLocalEmbeddingQuerySchema = z.strictObject({
  query: z.string(),
  threadId: Id,
});
export const PlatformLocalEmbeddingResultSchema = z.strictObject({
  embedding: z.array(z.number()),
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
