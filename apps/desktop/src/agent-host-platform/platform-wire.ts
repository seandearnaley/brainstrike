import {
  HOST_OBSERVER_AWAITING_REASONS,
  HostRewindConflictSchema,
  HostRewindFileOutcomeSchema,
  HostTurnSnapshotRootSchema,
  HostTurnSnapshotSchema,
} from '@brainstrike/agent-host/protocol';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  ReferencedFileFailureSchema,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { z } from 'zod';
import {
  PlatformMemoryOptionsSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
} from './platform-client-configuration';
import { InferencePlanSchema, QueryEmbeddingPayloadSchema } from './retrieval-wire';

export {
  PlatformClientConfigurationSchema,
  PlatformMemoryOptionsSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
  PlatformPolicySchema,
  type PlatformSubagentsIntent,
  PlatformSubagentsIntentSchema,
  platformPermissionPolicy,
} from './platform-client-configuration';

const Id = z.string().min(1);
/** ADR-0017: one native process the host started; `group` leaders are signalled as a whole group. */
export const PlatformNativeChildSchema = z.strictObject({
  group: z.boolean(),
  pid: z.number().int().positive(),
  start: z.string().min(1),
});
export const PlatformWorkspaceBindingRequestSchema = z.strictObject({
  binding: ThreadWorkspaceBindingSchema,
  threadId: Id,
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
  selectionFolderId: Id.optional(),
  /** The enabled skills of Main's one scan for this run; the host reads their files itself. */
  skills: z.array(PlatformAdmittedSkillSchema).optional(),
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
  referencedFileFailures: z.array(ReferencedFileFailureSchema).optional(),
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
});
/**
 * The one relay to Main's hidden embedding host (ADR-0007): a retrieval tool's
 * query, or an admitted local recall embedder's with its plan. The host's
 * admission decides which; Main answers the vector, or its refusal as data
 * (`RefusableOutcomeSchema`, BST-1996).
 */
export const PlatformEmbeddingQuerySchema = z.strictObject({
  request: QueryEmbeddingPayloadSchema,
});
/**
 * A host run's turn boundary, with the roots it snapshots: at its start the
 * roots its admission holds, at its end the start's roots. The host's
 * admission owns them; Main snapshots what it is sent.
 */
export const PlatformTurnSnapshotRequestSchema = z.discriminatedUnion('boundary', [
  z.strictObject({
    boundary: z.literal('turn-start'),
    roots: z.array(HostTurnSnapshotRootSchema),
    runId: Id,
    threadId: Id,
  }),
  z.strictObject({
    boundary: z.literal('turn-end'),
    roots: z.array(HostTurnSnapshotRootSchema).min(1),
    runId: Id,
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
 * thread/memory/read: the admission's pure preconditions, with nothing
 * acquired. Not ready carries what the admission fails with.
 */
export const PlatformMemoryReadinessSchema = z.union([
  z.strictObject({ ready: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({
    memory: PlatformSelectionSchema.shape.memory,
    ready: z.literal(true),
    resourceId: Id,
  }),
]);

/** BST-1930 stage e: the reads Main serves the host's run admission. */
export const PlatformCatalogModelSchema = z.strictObject({ model: Id, provider: Id });
export const PlatformCatalogModelResultSchema = z
  .strictObject({ isEnabled: z.boolean(), providerId: Id })
  .nullable();
export const PlatformObserverCandidatesSchema = z.strictObject({ candidates: z.array(Id) });
export const PlatformObserverCandidatesResultSchema = z.array(Id);
export const PlatformMemoryVectorsSchema = z.strictObject({
  settings: PlatformMemorySettingsSchema,
});
export const PlatformMemoryVectorsResultSchema = z
  .strictObject({
    /** A local recall embedder's exact plan, sent back with each borrowed query. */
    local: z.strictObject({ modelKey: Id, workerPlan: InferencePlanSchema.strict() }).optional(),
    profile: PlatformVectorProfileSchema,
  })
  .nullable();
export const PlatformWorkspaceLeaseSchema = z.strictObject({ leaseId: z.uuid() });
export const PlatformWorkspaceAcquireSchema = PlatformWorkspaceLeaseSchema.extend({
  binding: ThreadWorkspaceBindingSchema,
  threadId: Id,
});
export const PlatformWorkspaceAcquireResultSchema = z.strictObject({
  roots: CliWorkspaceRootsSchema,
});
