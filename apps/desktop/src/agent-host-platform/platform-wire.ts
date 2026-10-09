import type { RuntimeData } from '@brainstrike/agent/provider-runtime';
import {
  HOST_OBSERVER_AWAITING_REASONS,
  HostRewindConflictSchema,
  HostRewindFileOutcomeSchema,
  HostRunSnapshotSchema,
  HostTurnSnapshotRootSchema,
  HostTurnSnapshotSchema,
} from '@brainstrike/agent-host/protocol';
import {
  CliWorkspaceRootsSchema,
  CliWorkspaceSelectionSchema,
} from '@brainstrike/agent-host/standalone-workspace-input';
import type { PermissionToolGateSnapshot } from '@brainstrike/assistant-contract';
import {
  PERMISSION_DECISIONS,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { z } from 'zod';
import { QueryEmbeddingPayloadSchema, QueryEmbeddingResultSchema } from './retrieval-wire';

const Id = z.string().min(1);
const Decision = z.enum(PERMISSION_DECISIONS);
/** ADR-0017: one native process the host started; `group` leaders are signalled as a whole group. */
export const PlatformNativeChildSchema = z.strictObject({
  group: z.boolean(),
  pid: z.number().int().positive(),
  start: z.string().min(1),
});
export const PlatformRunRequestSchema = z.strictObject({
  configuration: z.record(z.string(), z.json()).optional(),
  modelId: Id,
  planMode: z.literal(true).optional(),
  prompt: z.string().optional(),
  /** The run this admission is for (HostRunAdmissionRequest.runId). */
  runId: Id,
  snapshot: HostRunSnapshotSchema.optional(),
  threadId: Id,
  workspaceBinding: ThreadWorkspaceBindingSchema.optional(),
});
/** A run's intent before any run exists (thread/memory/read): the request without its run. */
export const PlatformRunIntentSchema = PlatformRunRequestSchema.omit({ runId: true });
export const PlatformWorkspaceBindingRequestSchema = z.strictObject({
  binding: ThreadWorkspaceBindingSchema,
  /** The run being admitted, whose selection is revalidated; a binding update names none. */
  selectionRunId: Id.optional(),
  threadId: Id,
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
/** BST-1932: the renderer's subagent preferences, captured with each run's input. */
export const PlatformSubagentsIntentSchema = z.strictObject({
  delegationEnabled: z.boolean(),
  disabledPersonaIds: z.array(Id),
  settings: runtimeSubagentSettingsSchema,
});
export type PlatformSubagentsIntent = z.infer<typeof PlatformSubagentsIntentSchema>;
/** A resolved persona crossing from Main's persona owner to the host. */
const PlatformPersonaSchema = z.strictObject({
  allowedToolIds: z.array(Id),
  description: z.string(),
  id: Id,
  instructions: z.string(),
  label: z.string(),
  maxSteps: z.number().int().positive(),
  mode: z.enum(['read-only', 'worker']).optional(),
  model: z.strictObject({ modelId: Id, provider: Id }).optional(),
  source: z.enum(['built-in', 'user']).optional(),
});
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
  workspaceContext: PlatformWorkspaceContextSchema.optional(),
  workspaceInstructionsPreference: z.strictObject({
    masterEnabled: z.boolean(),
    oversizedOptInByRootId: z.record(z.string(), z.boolean()),
  }),
});
/** One enabled skill of the run's scan: its paths, frontmatter and SKILL.md instructions. */
export const PlatformAdmittedSkillSchema = z.strictObject({
  allowedTools: z.array(z.string()).exactOptional(),
  compatibility: z.json().exactOptional(),
  containmentRoot: z.string().min(1),
  description: z.string(),
  dirAbsPath: z.string().min(1),
  dirName: z.string().min(1),
  instructions: z.string(),
  license: z.string().exactOptional(),
  metadata: z.record(z.string(), z.json()).exactOptional(),
  name: z.string().min(1),
  preferenceKey: z.string().min(1),
  sourceRootDisplayName: z.string().exactOptional(),
  sourceRootId: Id.exactOptional(),
  tier: z.enum(['root-brainstrike', 'global-brainstrike', 'root-claude', 'global-claude']),
  userInvocable: z.boolean(),
  warnings: z.array(z.string()),
});

/** Admission data of the shared native tools; roots are revalidated per call via Main. */
export const PlatformNativeRuntimeSchema = z.strictObject({
  boundWorkspaceRootId: Id.optional(),
  provider: Id,
  /** Main admitted retrieval to the thread's own roots (a CLI selection or a binding). */
  retrievalRootsOnly: z.literal(true).optional(),
  /** The focused root's curated files, for the host's workspace-context reads. */
  selectionFilePaths: z.array(z.string()).optional(),
  selectionFolderId: Id.optional(),
  /** The enabled skills of Main's one scan for this run; the host reads their files itself. */
  skills: z.array(PlatformAdmittedSkillSchema).optional(),
  /** The request's curated context selection, as Main admitted it. */
  workspaceContext: PlatformWorkspaceContextSchema.optional(),
  workspaceRootPath: Id.optional(),
  workspaceRoots: CliWorkspaceRootsSchema,
});
export const PlatformSelectionSchema = z.strictObject({
  /** The host-supplied context a delegated child receives beside its persona instructions. */
  childSystem: z.string().optional(),
  configuration: PlatformModelConfigurationSchema,
  contextWindow: z.number().int().positive(),
  delegation: z
    .strictObject({
      personas: z.array(PlatformPersonaSchema),
      settings: runtimeSubagentSettingsSchema,
    })
    .optional(),
  durableConfiguration: z.record(z.string(), z.json()),
  inputTokenLimit: z.number().int().positive(),
  maxSteps: z.number().int().positive(),
  memory: z.strictObject({
    /** Observations are on, but Main resolved no observer this run can use. */
    observerAwaiting: z.enum(HOST_OBSERVER_AWAITING_REASONS).optional(),
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
  selectionRunId: Id,
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
  selectionRunId: Id,
});
/**
 * The one relay to Main's hidden embedding host (ADR-0007) for an admitted
 * thread: its local recall (`query`; Main supplies the admitted saved plan,
 * which never crosses the wire) or a retrieval tool's query (`request`, the
 * payload the tool resolved from Main's catalog). Either answers the vector.
 */
export const PlatformEmbeddingQuerySchema = z.union([
  z.strictObject({ query: z.string(), selectionRunId: Id }),
  z.strictObject({ request: QueryEmbeddingPayloadSchema, selectionRunId: Id, threadId: Id }),
]);
export const PlatformEmbeddingResultSchema = QueryEmbeddingResultSchema;
/**
 * A host run's turn boundary: its start snapshots the thread's admitted
 * roots; its end, after Main released the selection, the start's roots.
 */
/** `selectionRunId` is the admitting run, whose selection's roots a turn start snapshots. */
export const PlatformTurnSnapshotRequestSchema = z.discriminatedUnion('boundary', [
  z.strictObject({
    boundary: z.literal('turn-start'),
    runId: Id,
    selectionRunId: Id,
    threadId: Id,
  }),
  z.strictObject({
    boundary: z.literal('turn-end'),
    roots: z.array(HostTurnSnapshotRootSchema).min(1),
    runId: Id,
    selectionRunId: Id,
    threadId: Id,
  }),
]);
export const PlatformTurnSnapshotResultSchema = z.array(HostTurnSnapshotSchema);
/** A host rewind's restore requests over Main's snapshot owner (`HostRewindFiles`). */
const RewindTargets = z.array(HostTurnSnapshotSchema);
export const PlatformRewindPreviewSchema = z.strictObject({ targets: RewindTargets, threadId: Id });
export const PlatformRewindDriftSchema = z.strictObject({ previewId: Id, threadId: Id });
export const PlatformRewindApplySchema = z.strictObject({
  previewId: Id,
  rewindId: Id,
  targets: RewindTargets,
  threadId: Id,
});
export const PlatformRewindRedoConflictsSchema = z.strictObject({
  rewindId: Id,
  targets: RewindTargets,
  threadId: Id,
});
export const PlatformRewindRedoSchema = PlatformRewindRedoConflictsSchema.extend({
  acknowledged: z.array(HostRewindConflictSchema),
});
export const PlatformRewindPreviewResultSchema = z.strictObject({ previewId: Id });
export const PlatformRewindConflictsSchema = z.array(HostRewindConflictSchema);
export const PlatformRewindOutcomesSchema = z.array(HostRewindFileOutcomeSchema);
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
/**
 * thread/memory/read: the admission's pure preconditions, evaluated by Main
 * with nothing acquired. Not ready carries what `platform/admit` fails with.
 */
export const PlatformMemoryReadinessSchema = z.union([
  z.strictObject({ ready: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({
    memory: PlatformSelectionSchema.shape.memory,
    ready: z.literal(true),
    resourceId: Id,
  }),
]);
