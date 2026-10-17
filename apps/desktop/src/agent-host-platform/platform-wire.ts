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
import { Schema } from 'effect';
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

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/** ADR-0017: one native process the host started; `group` leaders are signalled as a whole group. */
export const PlatformNativeChildSchema = Schema.Struct({
  group: Schema.Boolean,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isMinCodePoints(1)),
});
export const PlatformWorkspaceBindingRequestSchema = Schema.Struct({
  binding: ThreadWorkspaceBindingSchema,
  threadId: Id,
});
/** The indexer's one vector profile rule validates a recall embedding profile. */
const PlatformVectorProfileSchema = Schema.declare(
  (input: unknown): input is VectorProfile => {
    try {
      vectorProfileHash(input);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Memory vectors require a supported embedding profile' }
);
/** A resolved persona crossing from Main's persona owner to the host. */
const PlatformPersonaSchema = Schema.Struct({
  allowedToolIds: Schema.mutable(Schema.Array(Id)),
  description: Schema.String,
  id: Id,
  instructions: Schema.String,
  label: Schema.String,
  maxSteps: Schema.Int.check(Schema.isGreaterThan(0)),
  mode: Schema.optional(Schema.Literals(['read-only', 'worker'])),
  model: Schema.optional(Schema.Struct({ modelId: Id, provider: Id })),
  source: Schema.optional(Schema.Literals(['built-in', 'user'])),
});
/** One enabled skill of the run's scan: its paths, frontmatter and SKILL.md instructions. */
export const PlatformAdmittedSkillSchema = Schema.Struct({
  allowedTools: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  compatibility: Schema.optionalKey(Schema.MutableJson),
  containmentRoot: Schema.String.check(Schema.isMinCodePoints(1)),
  description: Schema.String,
  dirAbsPath: Schema.String.check(Schema.isMinCodePoints(1)),
  dirName: Schema.String.check(Schema.isMinCodePoints(1)),
  instructions: Schema.String,
  license: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.MutableJson)),
  name: Schema.String.check(Schema.isMinCodePoints(1)),
  preferenceKey: Schema.String.check(Schema.isMinCodePoints(1)),
  sourceRootDisplayName: Schema.optionalKey(Schema.String),
  sourceRootId: Schema.optionalKey(Id),
  tier: Schema.Literals(['root-brainstrike', 'global-brainstrike', 'root-claude', 'global-claude']),
  userInvocable: Schema.Boolean,
  warnings: Schema.mutable(Schema.Array(Schema.String)),
});
/** Admission data of the shared native tools; roots are revalidated per call via Main. */
export const PlatformNativeRuntimeSchema = Schema.Struct({
  boundWorkspaceRootId: Schema.optional(Id),
  provider: Id,
  retrievalRootsOnly: Schema.optional(Schema.Literal(true)),
  selectionFolderId: Schema.optional(Id),
  skills: Schema.optional(Schema.mutable(Schema.Array(PlatformAdmittedSkillSchema))),
  workspaceRootPath: Schema.optional(Id),
  workspaceRoots: CliWorkspaceRootsSchema,
});
export const PlatformSelectionSchema = Schema.Struct({
  childSystem: Schema.optional(Schema.String),
  configuration: PlatformModelConfigurationSchema,
  contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
  delegation: Schema.optional(
    Schema.Struct({
      personas: Schema.mutable(Schema.Array(PlatformPersonaSchema)),
      settings: runtimeSubagentSettingsSchema,
    })
  ),
  durableConfiguration: Schema.Record(Schema.String, Schema.MutableJson),
  inputTokenLimit: Schema.Int.check(Schema.isGreaterThan(0)),
  maxSteps: Schema.Int.check(Schema.isGreaterThan(0)),
  memory: Schema.Struct({
    observerAwaiting: Schema.optional(Schema.Literals(HOST_OBSERVER_AWAITING_REASONS)),
    options: PlatformMemoryOptionsSchema,
    settings: PlatformMemorySettingsSchema,
    vectorProfile: Schema.optional(PlatformVectorProfileSchema),
  }),
  nativeRuntime: PlatformNativeRuntimeSchema,
  referencedFileFailures: Schema.optional(
    Schema.mutable(Schema.Array(ReferencedFileFailureSchema))
  ),
  resourceId: Id,
  system: Schema.optional(Schema.String),
  tools: Schema.Record(
    Schema.String,
    Schema.Struct({
      description: Schema.String,
      identity: Id,
      inputSchema: Schema.Record(Schema.String, Schema.MutableJson),
      interaction: Schema.optional(
        Schema.Struct({
          kind: Schema.Literals(['question', 'plan']),
          resumeSchema: Schema.Record(Schema.String, Schema.MutableJson),
        })
      ),
      permissionToolId: Id,
      risk: Schema.Literals(TOOL_RISK_CATEGORIES),
      strict: Schema.optional(Schema.Boolean),
    })
  ),
  toolTimeoutMs: Schema.Finite.check(Schema.isGreaterThan(0)),
  workspace: Schema.optional(
    Schema.Struct({ boundWorkspaceRootId: Id, roots: CliWorkspaceRootsSchema })
  ),
});
/**
 * The one relay to Main's hidden embedding host (ADR-0007): a retrieval tool's
 * query, or an admitted local recall embedder's with its plan. The host's
 * admission decides which; Main answers the vector, or its refusal as data
 * (`RefusableOutcomeSchema`, BST-1996).
 */
export const PlatformEmbeddingQuerySchema = Schema.Struct({ request: QueryEmbeddingPayloadSchema });
/**
 * A host run's turn boundary, with the roots it snapshots: at its start the
 * roots its admission holds, at its end the start's roots. The host's
 * admission owns them; Main snapshots what it is sent.
 */
export const PlatformTurnSnapshotRequestSchema = Schema.Union(
  [
    Schema.Struct({
      boundary: Schema.Literal('turn-start'),
      roots: Schema.mutable(Schema.Array(HostTurnSnapshotRootSchema)),
      runId: Id,
      threadId: Id,
    }),
    Schema.Struct({
      boundary: Schema.Literal('turn-end'),
      roots: Schema.mutable(Schema.Array(HostTurnSnapshotRootSchema)).check(Schema.isMinLength(1)),
      runId: Id,
      threadId: Id,
    }),
  ],
  { mode: 'oneOf' }
);
export const PlatformTurnSnapshotResultSchema = Schema.mutable(
  Schema.Array(HostTurnSnapshotSchema)
);
/** A host rewind's restore requests over Main's snapshot owner (`HostRewindFiles`). */
const RewindTargets = Schema.mutable(Schema.Array(HostTurnSnapshotSchema));
export const PlatformRewindPreviewSchema = Schema.Struct({ targets: RewindTargets, threadId: Id });
export const PlatformRewindDriftSchema = Schema.Struct({ previewId: Id, threadId: Id });
export const PlatformRewindApplySchema = Schema.Struct({
  previewId: Id,
  rewindId: Id,
  targets: RewindTargets,
  threadId: Id,
});
export const PlatformRewindRedoConflictsSchema = Schema.Struct({
  rewindId: Id,
  targets: RewindTargets,
  threadId: Id,
});
export const PlatformRewindRedoSchema = Schema.Struct({
  ...PlatformRewindRedoConflictsSchema.fields,
  ...{ acknowledged: Schema.mutable(Schema.Array(HostRewindConflictSchema)) },
});
export const PlatformRewindPreviewResultSchema = Schema.Struct({ previewId: Id });
export const PlatformRewindConflictsSchema = Schema.mutable(Schema.Array(HostRewindConflictSchema));
export const PlatformRewindOutcomesSchema = Schema.mutable(
  Schema.Array(HostRewindFileOutcomeSchema)
);
/** Confidential, private launcher channel only; absent from client protocol and log. */
export const PlatformAuthSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('custom_fetch') }),
  Schema.Struct({ apiKey: Schema.String, kind: Schema.Literal('api_key') }),
  Schema.Struct({ apiKey: Schema.String, kind: Schema.Literal('aws'), region: Id }),
  Schema.Struct({
    identity: Schema.Struct({
      accessKeyId: Id,
      accountId: Schema.optional(Schema.String),
      credentialScope: Schema.optional(Schema.String),
      expiration: Schema.optional(Schema.String.check(Schema.isPattern(z.regexes.datetime({})))),
      secretAccessKey: Id,
      sessionToken: Schema.optional(Schema.String),
    }),
    kind: Schema.Literal('aws'),
    region: Id,
  }),
  Schema.Null,
]);
export type PlatformSelection = (typeof PlatformSelectionSchema)['Type'];
/**
 * thread/memory/read: the admission's pure preconditions, with nothing
 * acquired. Not ready carries what the admission fails with.
 */
export const PlatformMemoryReadinessSchema = Schema.Union([
  Schema.Struct({
    ready: Schema.Literal(false),
    reason: Schema.String.check(Schema.isMinCodePoints(1)),
  }),
  Schema.Struct({
    memory: PlatformSelectionSchema.fields.memory,
    ready: Schema.Literal(true),
    resourceId: Id,
  }),
]);
/** BST-1930 stage e: the reads Main serves the host's run admission. */
export const PlatformCatalogModelSchema = Schema.Struct({ model: Id, provider: Id });
export const PlatformCatalogModelResultSchema = Schema.NullOr(
  Schema.Struct({ isEnabled: Schema.Boolean, providerId: Id })
);
export const PlatformObserverCandidatesSchema = Schema.Struct({
  candidates: Schema.mutable(Schema.Array(Id)),
});
export const PlatformObserverCandidatesResultSchema = Schema.mutable(Schema.Array(Id));
export const PlatformMemoryVectorsSchema = Schema.Struct({
  settings: PlatformMemorySettingsSchema,
});
export const PlatformMemoryVectorsResultSchema = Schema.NullOr(
  Schema.Struct({
    local: Schema.optional(Schema.Struct({ modelKey: Id, workerPlan: InferencePlanSchema })),
    profile: PlatformVectorProfileSchema,
  })
);
export const PlatformWorkspaceLeaseSchema = Schema.Struct({
  leaseId: Schema.String.check(Schema.isUUID()),
});
export const PlatformWorkspaceAcquireSchema = Schema.Struct({
  ...PlatformWorkspaceLeaseSchema.fields,
  ...{ binding: ThreadWorkspaceBindingSchema, threadId: Id },
});
export const PlatformWorkspaceAcquireResultSchema = Schema.Struct({
  roots: CliWorkspaceRootsSchema,
});
