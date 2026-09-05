import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { RenameWorkspaceFileInputSchema } from '../schemas/schemas-workspace.js';

// Renames/moves a single workspace FILE within one root. riskCategory 'edit' so
// the permission engine gates it (→ 'ask' by default) like the other
// file-mutation tools; cross-root moves and overwrites are refused by the tool.
export const renameWorkspaceFile = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 150,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Rename or move a single file within a chosen open workspace root, creating missing destination parents and invalidating the source index rows. Refuses overwriting an existing destination and refuses directories; refuses if the source changed on disk since you last read it — re-read and retry; acts on a symlink itself (moves the link, never its target). Workspace-scoped; requires approval',
  discovery: { family: 'file delete/rename', namespace: 'workspace' },
  id: 'brainstrike.renameWorkspaceFile',
  inputSchema: providerCompatibleInputSchema(RenameWorkspaceFileInputSchema),
  kind: 'desktop',
  returns:
    'Rename result: ok: true, the normalized fromPath and toPath, rootName, and indexInvalidated (true when the source path had workspace-index rows that were removed; the destination is re-indexed by the background sync)',
  surfaces: ['desktop', 'web'],
});
