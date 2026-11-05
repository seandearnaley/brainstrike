import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { RenameWorkspaceFileInputSchema } from '../schemas/schemas-workspace.ts';

// Renames/moves a single workspace FILE within one root. riskCategory 'edit' so
// the permission engine gates it (→ 'ask' by default) like the other
// file-mutation tools; cross-root moves and overwrites are refused by the tool.
export const renameWorkspaceFile = defineNativeTool({
  activity: {
    active: 'Renaming',
    countsFiles: 'always',
    done: 'Renamed',
    family: 'edit',
    request: 'Rename',
  },
  defaults: {
    category: 'action',
    estimatedTokens: 150,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Rename or move a single file within a chosen open workspace root, creating missing destination parents. Refuses overwriting an existing destination and refuses directories; refuses if the source changed on disk since you last read it — re-read and retry; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
  discovery: { family: 'file delete/rename', namespace: 'workspace' },
  id: 'brainstrike.renameWorkspaceFile',
  inputSchema: effectToolInputSchema(RenameWorkspaceFileInputSchema),
  kind: 'desktop',
  returns: 'Rename result: ok: true, the normalized fromPath and toPath, and rootName',
  surfaces: ['desktop', 'web'],
});
