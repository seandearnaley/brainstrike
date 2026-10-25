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

/**
 * ADR-0029 stage 2: the skills and user slash commands the desktop's roots and
 * home directory hold, scanned by the host as its runs scan them.
 */
export const WORKSPACE_DISCOVERY_METHOD_SCHEMAS = {
  'workspace/commands': Schema.Record(Schema.String, Schema.Never),
  'workspace/skills': Schema.Record(Schema.String, Schema.Never),
} as const;
export const WORKSPACE_DISCOVERY_RESULT_SCHEMAS = {
  'workspace/commands': UserSlashCommandsListResultSchema,
  'workspace/skills': SkillsScanResultSchema,
} as const;
