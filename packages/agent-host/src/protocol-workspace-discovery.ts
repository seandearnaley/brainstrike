import type {
  AssistantPersonasListResult,
  SkillsScanResultSummary,
  UserSlashCommandsListResult,
  WorkspaceContextFileStatus,
} from '@brainstrike/assistant-contract';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;
const Texts = Schema.mutable(Schema.Array(Text));
const SkillTier = Schema.Literals([
  'root-brainstrike',
  'global-brainstrike',
  'root-claude',
  'global-claude',
]);
const SkillScanEntrySchema = Schema.Struct({
  absPath: Text,
  description: Schema.optionalKey(Text),
  dirName: Text,
  errors: Schema.optionalKey(Texts),
  name: Schema.optionalKey(Text),
  preferenceKey: Schema.optionalKey(Text),
  shadowedBy: Schema.optionalKey(Schema.Struct({ absPath: Text, tier: SkillTier })),
  sourceRootDisplayName: Schema.optionalKey(Text),
  sourceRootId: Schema.optionalKey(Id),
  status: Schema.Literals(['invalid', 'ok', 'shadowed']),
  tier: SkillTier,
  userInvocable: Schema.optionalKey(Schema.Boolean),
  warnings: Schema.optionalKey(Texts),
});
// The wire decodes into the shared contracts the Settings panel and "/" menu read.
const SkillsScanResultSchema = Schema.Struct({
  entries: Schema.mutable(Schema.Array(SkillScanEntrySchema)),
}) satisfies Schema.ConstraintDecoder<SkillsScanResultSummary>;
const UserSlashCommandsListResultSchema = Schema.Struct({
  commands: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        description: Schema.optionalKey(Text),
        id: Id,
        label: Text,
        sourceRootId: Schema.optionalKey(Id),
        template: Text,
      })
    )
  ),
  roots: Schema.mutable(Schema.Array(Schema.Struct({ displayName: Text, id: Id }))),
}) satisfies Schema.ConstraintDecoder<UserSlashCommandsListResult>;

const PersonaListItemSchema = Schema.Struct({
  absPath: Schema.optionalKey(Text),
  allowedToolIds: Schema.optionalKey(Texts),
  availability: Schema.optionalKey(
    Schema.Struct({
      issues: Schema.mutable(
        Schema.Array(
          Schema.Struct({
            code: Schema.Literals([
              'credential-missing',
              'credential-unreadable',
              'model-not-listed',
              'model-unsupported',
              'tool-not-discovered',
              'tool-disabled',
            ]),
            message: Text,
            toolId: Schema.optionalKey(Text),
          })
        )
      ),
      status: Schema.Literals(['blocked', 'needs-attention', 'request-dependent']),
    })
  ),
  description: Text,
  error: Schema.optionalKey(Text),
  id: Id,
  label: Text,
  maxSteps: Schema.optionalKey(Schema.Int),
  mode: Schema.optionalKey(Schema.Literals(['read-only', 'worker'])),
  modelPin: Schema.optionalKey(Text),
  shadowedBy: Schema.optionalKey(
    Schema.Struct({ absPath: Text, sourceRootId: Schema.optionalKey(Id) })
  ),
  source: Schema.Literals(['built-in', 'user']),
  sourceRootId: Schema.optionalKey(Id),
  status: Schema.Literals(['invalid', 'ok', 'shadowed']),
});
const PersonasListResultSchema = Schema.Struct({
  incompleteDirs: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({ dir: Text, reason: Schema.Literals(['cap-reached', 'listing-truncated']) })
      )
    )
  ),
  personas: Schema.mutable(Schema.Array(PersonaListItemSchema)),
}) satisfies Schema.ConstraintDecoder<AssistantPersonasListResult>;
const NullableCount = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));
const ContextFileStatusSchema = Schema.Struct({
  approxTokens: NullableCount,
  displayName: Text,
  error: Schema.optionalKey(Text),
  fileName: Schema.NullOr(Text),
  oversized: Schema.Boolean,
  path: Schema.NullOr(Text),
  rootId: Id,
  sizeBytes: NullableCount,
  status: Schema.Literals(['none', 'fits', 'oversized', 'error']),
}) satisfies Schema.ConstraintDecoder<WorkspaceContextFileStatus>;

/** ADR-0032: the person's answer for a folder. Only `trusted` loads its agent configuration. */
export const HostWorkspaceTrustDecisionSchema = Schema.Literals(['trusted', 'restricted']);
export type HostWorkspaceTrustDecision = (typeof HostWorkspaceTrustDecisionSchema)['Type'];
/** A folder's trust: the person's answer, or undecided until they give one. */
export const HostWorkspaceTrustSchema = Schema.Literals(['trusted', 'restricted', 'undecided']);
export type HostWorkspaceTrust = (typeof HostWorkspaceTrustSchema)['Type'];
const AbsolutePath = Schema.String.check(Schema.isMinCodePoints(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * What trusting a live root would load: its workspace instructions file and
 * its project skills, slash commands and personas, found by the same scans a
 * run uses. `answeredBy` is the folder whose answer the root shares when it is
 * not its own, a managed worktree's repository (ADR-0034 decision 6): its
 * `path` and `displayName` are that folder's own entry's when it is listed
 * too, so entries that share an answer group by it. `trustedThrough` is the
 * trusted location a root with no answer of its own is trusted through.
 * `offeredLocation` is the parent a trust ask for the root may offer as a
 * trusted location, named so the ask can show it and send it back: absent for
 * a trusted root, for a parent that is one already, and for the top of the
 * filesystem, the home directory or a folder that holds it, and a folder
 * other people can write to.
 */
const WorkspaceTrustRootSchema = Schema.Struct({
  agentConfiguration: Schema.Struct({
    commands: Count,
    instructions: Schema.NullOr(Text),
    personas: Count,
    skills: Count,
  }),
  answeredBy: Schema.optionalKey(Schema.Struct({ displayName: Text, path: AbsolutePath })),
  displayName: Text,
  offeredLocation: Schema.optionalKey(AbsolutePath),
  path: AbsolutePath,
  rootId: Id,
  trust: HostWorkspaceTrustSchema,
  trustedThrough: Schema.optionalKey(AbsolutePath),
});
export type HostWorkspaceTrustRoot = (typeof WorkspaceTrustRootSchema)['Type'];

/**
 * ADR-0029 stage 2: the skills and user slash commands the desktop's roots and
 * home directory hold, scanned by the host as its runs scan them. ADR-0032:
 * project tiers come only from trusted roots, and `workspace/trust/list` says
 * what each live root would contribute once trusted. Stage 2a: Settings'
 * persona list with the host's preflight checks, and each trusted root's
 * workspace instructions file (`workspace/personas`, `workspace/context-files`),
 * which only the desktop's private client reaches.
 */
export const WORKSPACE_DISCOVERY_METHOD_SCHEMAS = {
  'workspace/commands': Schema.Record(Schema.String, Schema.Never),
  'workspace/context-files': Schema.Record(Schema.String, Schema.Never),
  'workspace/personas': Schema.Record(Schema.String, Schema.Never),
  'workspace/skills': Schema.Record(Schema.String, Schema.Never),
  /**
   * Record the person's answer for the folder at an absolute path; the host is
   * the only writer. `location` also records that folder's parent as a trusted
   * location: it names the parent the ask showed, and the host refuses any
   * other folder.
   */
  'workspace/trust': Schema.Struct({
    location: Schema.optionalKey(AbsolutePath),
    path: AbsolutePath,
    trust: HostWorkspaceTrustDecisionSchema,
  }),
  'workspace/trust/list': Schema.Record(Schema.String, Schema.Never),
  /** The trusted locations: every folder inside one is trusted without an ask. */
  'workspace/trust/locations': Schema.Record(Schema.String, Schema.Never),
  /** Remove a trusted location by the path it is listed under; folders' own answers stay. */
  'workspace/trust/locations/remove': Schema.Struct({ path: AbsolutePath }),
  'workspace/trust/read': Schema.Struct({ path: AbsolutePath }),
} as const;
export const WORKSPACE_DISCOVERY_RESULT_SCHEMAS = {
  'workspace/commands': UserSlashCommandsListResultSchema,
  'workspace/context-files': Schema.Struct({
    files: Schema.mutable(Schema.Array(ContextFileStatusSchema)),
  }),
  'workspace/personas': PersonasListResultSchema,
  'workspace/skills': SkillsScanResultSchema,
  'workspace/trust': Schema.Struct({ trust: HostWorkspaceTrustDecisionSchema }),
  'workspace/trust/list': Schema.Struct({
    roots: Schema.mutable(Schema.Array(WorkspaceTrustRootSchema)),
  }),
  'workspace/trust/locations': Schema.Struct({
    locations: Schema.mutable(Schema.Array(Schema.Struct({ path: AbsolutePath }))),
  }),
  'workspace/trust/locations/remove': Schema.Struct({ removed: Schema.Boolean }),
  /**
   * `offeredLocation` is the parent a `workspace/trust` for the folder may name
   * as its `location`, whatever the folder's trust is now. Absent when the host
   * offers none.
   */
  'workspace/trust/read': Schema.Struct({
    offeredLocation: Schema.optionalKey(AbsolutePath),
    trust: HostWorkspaceTrustSchema,
  }),
} as const;
