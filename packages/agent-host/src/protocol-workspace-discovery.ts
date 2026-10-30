import type {
  SkillsScanResultSummary,
  UserSlashCommandsListResult,
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
 * run uses.
 */
const WorkspaceTrustRootSchema = Schema.Struct({
  agentConfiguration: Schema.Struct({
    commands: Count,
    instructions: Schema.NullOr(Text),
    personas: Count,
    skills: Count,
  }),
  displayName: Text,
  path: AbsolutePath,
  rootId: Id,
  trust: HostWorkspaceTrustSchema,
});
export type HostWorkspaceTrustRoot = (typeof WorkspaceTrustRootSchema)['Type'];

/**
 * ADR-0029 stage 2: the skills and user slash commands the desktop's roots and
 * home directory hold, scanned by the host as its runs scan them. ADR-0032:
 * project tiers come only from trusted roots, and `workspace/trust/list` says
 * what each live root would contribute once trusted.
 */
export const WORKSPACE_DISCOVERY_METHOD_SCHEMAS = {
  'workspace/commands': Schema.Record(Schema.String, Schema.Never),
  'workspace/skills': Schema.Record(Schema.String, Schema.Never),
  /** Record the person's answer for the folder at an absolute path; the host is the only writer. */
  'workspace/trust': Schema.Struct({ path: AbsolutePath, trust: HostWorkspaceTrustDecisionSchema }),
  'workspace/trust/list': Schema.Record(Schema.String, Schema.Never),
  'workspace/trust/read': Schema.Struct({ path: AbsolutePath }),
} as const;
export const WORKSPACE_DISCOVERY_RESULT_SCHEMAS = {
  'workspace/commands': UserSlashCommandsListResultSchema,
  'workspace/skills': SkillsScanResultSchema,
  'workspace/trust': Schema.Struct({ trust: HostWorkspaceTrustDecisionSchema }),
  'workspace/trust/list': Schema.Struct({
    roots: Schema.mutable(Schema.Array(WorkspaceTrustRootSchema)),
  }),
  'workspace/trust/read': Schema.Struct({ trust: HostWorkspaceTrustSchema }),
} as const;
