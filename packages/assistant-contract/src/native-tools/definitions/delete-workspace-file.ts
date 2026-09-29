import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { DeleteWorkspaceFileInputSchema } from '../schemas/schemas-workspace.js';

// Deletes a single workspace FILE. riskCategory 'edit' so the permission engine
// gates it (→ 'ask' by default) like the other file-mutation tools; directory
// deletes are refused by the tool itself.
export const deleteWorkspaceFile = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Permanently delete a single file in a chosen open workspace root and invalidate its index rows. DESTRUCTIVE and NOT recoverable through the tool; refuses directories (use executeCommand) and acts on a symlink itself (removes the link, never its target). Workspace-scoped; requires approval',
  discovery: { family: 'file delete/rename', namespace: 'workspace' },
  id: 'brainstrike.deleteWorkspaceFile',
  inputSchema: providerCompatibleInputSchema(DeleteWorkspaceFileInputSchema),
  kind: 'desktop',
  returns:
    'Delete result: ok: true, the normalized workspace path, rootName, and indexInvalidated (true when the file had workspace-index rows that were removed)',
  surfaces: ['desktop', 'web'],
});
