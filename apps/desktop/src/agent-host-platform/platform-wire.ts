import { HOST_OBSERVER_AWAITING_REASONS } from '@brainstrike/agent-host/protocol';
import { CliWorkspaceRootsSchema } from '@brainstrike/agent-host/standalone-workspace-input';
import {
  ReferencedFileFailureSchema,
  runtimeSubagentSettingsSchema,
  TOOL_RISK_CATEGORIES,
} from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import {
  PlatformMemoryOptionsSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
} from './platform-client-configuration';

export {
  PlatformClientConfigurationSchema,
  PlatformMemorySettingsSchema,
  PlatformModelConfigurationSchema,
  platformPermissionPolicy,
} from './platform-client-configuration';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/**
 * BST-2202: the agent host's warn, error and fatal log records reach Main's
 * diagnostics, as MCP's records do (`platform/mcp/diagnostics`), so the cause a
 * correlation id names is in the desktop log and debug bundle.
 */
export const PLATFORM_DIAGNOSTICS_RECORD_METHOD = 'platform/diagnostics/record';
/** One record as its producer's logger redacted it, bounded to JSON. */
export const PlatformDiagnosticRecordSchema = Schema.Struct({
  record: Schema.Struct({
    args: Schema.mutable(Schema.Array(Schema.MutableJson)),
    bindings: Schema.Record(Schema.String, Schema.MutableJson),
    level: Schema.Literals(['warn', 'error', 'fatal']),
    message: Schema.optional(Schema.String),
    scope: Schema.optional(Id.check(Schema.isMaxCodePoints(128))),
    timestamp: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
/** ADR-0029: Main lends its safeStorage cipher to the host's sealed credential file. */
export const PlatformCredentialSealSchema = Schema.Struct({ plaintext: Schema.String });
export const PlatformCredentialOpenSchema = Schema.Struct({ sealed: Id });
/** ADR-0017: one native process the host started; `group` leaders are signalled as a whole group. */
export const PlatformNativeChildSchema = Schema.Struct({
  group: Schema.Boolean,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isMinCodePoints(1)),
});

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
      permissionToolId: Id,
      risk: Schema.Literals(TOOL_RISK_CATEGORIES),
    })
  ),
  toolTimeoutMs: Schema.Finite.check(Schema.isGreaterThan(0)),
  workspace: Schema.optional(
    Schema.Struct({ boundWorkspaceRootId: Id, roots: CliWorkspaceRootsSchema })
  ),
});
/** ADR-0029 stage 4: a folder the host opened that the focused window should show. */
export const PlatformShowFolderSchema = Schema.Struct({ path: Id });
/** Main's native folder picker: the chosen folder, or the person's cancel. */
export const PlatformPickFolderResultSchema = Schema.Union(
  [Schema.Struct({ path: Id }), Schema.Struct({ cancelled: Schema.Literal(true) })],
  { mode: 'oneOf' }
);
/**
 * The host's open folders changed: the OS recent documents and File > Open Recent follow the
 * recent-folders ledger.
 */
export const PlatformRootsChangedSchema = Schema.Struct({
  grantedPath: Schema.optionalKey(Id),
  recentPaths: Schema.Array(Id),
});
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
