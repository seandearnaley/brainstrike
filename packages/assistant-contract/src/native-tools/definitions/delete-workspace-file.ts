import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { DeleteWorkspaceFileInputSchema } from '../schemas/schemas-workspace.ts';

// Deletes a single workspace FILE. riskCategory 'edit' so the permission engine
// gates it (→ 'ask' by default) like the other file-mutation tools; directory
// deletes are refused by the tool itself.
export const deleteWorkspaceFile = defineNativeTool({
  activity: {
    active: 'Deleting',
    countsFiles: 'always',
    done: 'Deleted',
    family: 'edit',
    request: 'Delete',
  },
  defaults: {
    category: 'action',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Permanently delete a single file in a chosen open workspace root. DESTRUCTIVE and NOT recoverable through the tool; refuses directories (use executeCommand) and acts on a symlink itself (removes the link, never its target). Workspace-scoped; requires approval',
  discovery: { family: 'file delete/rename', namespace: 'workspace' },
  id: 'brainstrike.deleteWorkspaceFile',
  inputSchema: effectToolInputSchema(DeleteWorkspaceFileInputSchema),
  kind: 'desktop',
  returns: 'Delete result: ok: true, the normalized workspace path and rootName',
  surfaces: ['desktop', 'web'],
});
