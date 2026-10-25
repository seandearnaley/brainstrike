import {
  HOST_OBSERVER_AWAITING_REASONS,
  InferencePlanSchema,
} from '@brainstrike/agent-host/protocol';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  ReferencedFileFailureSchema,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { Schema } from 'effect';
import { NATIVE_INDEX_WORKFLOW_SCOPE } from '../native-index-effect-diagnostics';
import {
  PlatformMemoryOptionsSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
} from './platform-client-configuration';
import { QueryEmbeddingPayloadSchema } from './retrieval-wire';

export {
  PlatformClientConfigurationSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
  platformPermissionPolicy,
} from './platform-client-configuration';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/**
 * BST-2202: the agent host's error and fatal log records, and its search index's
 * workflow timeline at every level, reach Main's diagnostics, as MCP's records do (`platform/mcp/diagnostics`), so the cause a
 * correlation id names is in the desktop log and debug bundle.
 */
export const PLATFORM_DIAGNOSTICS_RECORD_METHOD = 'platform/diagnostics/record';
const DiagnosticRecordFields = {
  args: Schema.mutable(Schema.Array(Schema.MutableJson)),
  bindings: Schema.Record(Schema.String, Schema.MutableJson),
  message: Schema.optional(Schema.String),
  timestamp: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
};
/**
 * One record as its producer's logger redacted it, bounded to JSON: an error or fatal record of
 * any scope, or the search index's workflow timeline at any level.
 */
export const PlatformDiagnosticRecordSchema = Schema.Struct({
  record: Schema.Union([
    Schema.Struct({
      ...DiagnosticRecordFields,
      level: Schema.Literals(['error', 'fatal']),
      scope: Schema.optional(Id.check(Schema.isMaxCodePoints(128))),
    }),
    Schema.Struct({
      ...DiagnosticRecordFields,
      level: Schema.Literals(['trace', 'debug', 'info', 'warn']),
      scope: Schema.Literal(NATIVE_INDEX_WORKFLOW_SCOPE),
    }),
  ]),
});
/** ADR-0017: one native process the host started; `group` leaders are signalled as a whole group. */
export const PlatformNativeChildSchema = Schema.Struct({
  group: Schema.Boolean,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isMinCodePoints(1)),
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
/** The workspace index's document embeddings, from Main's embedding renderer. */
export const PLATFORM_EMBEDDING_DOCUMENTS = 'platform/embedding/documents';
/** The index's remedy for an unresponsive embedding renderer. */
export const PLATFORM_EMBEDDING_RESTART = 'platform/embedding/restart';
export const PlatformEmbeddingDocumentsSchema = Schema.Struct({ request: Schema.Unknown });
export const PlatformEmbeddingDocumentsResultSchema = Schema.Array(Schema.Array(Schema.Number));
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
/**
 * BST-754: what admission asks Main's local runtime catalog about the selected
 * Ollama model (its `/api/show`), at the run configuration's endpoint.
 */
export const PlatformLocalModelSchema = Schema.Struct({
  endpoint: Schema.optional(
    Schema.Struct({
      apiToken: Schema.optional(Schema.String),
      baseUrl: Schema.optional(Schema.String),
    })
  ),
  model: Id,
});
const ContextTokens = Schema.Int.check(Schema.isGreaterThan(0));
export const PlatformLocalModelResultSchema = Schema.Union([
  Schema.Struct({
    contextLength: Schema.Union([
      Schema.Struct({
        key: Schema.String,
        state: Schema.Literal('reported'),
        tokens: ContextTokens,
      }),
      Schema.Struct({ state: Schema.Literal('unreported') }),
      Schema.Struct({ detail: Schema.String, state: Schema.Literal('malformed') }),
    ]),
    endpoint: Schema.String,
    state: Schema.Literal('resolved'),
    thinking: Schema.Boolean,
  }),
  Schema.Struct({
    endpoint: Schema.String,
    message: Schema.String,
    state: Schema.Literal('unavailable'),
  }),
]);
export type PlatformLocalModel = (typeof PlatformLocalModelResultSchema)['Type'];
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
