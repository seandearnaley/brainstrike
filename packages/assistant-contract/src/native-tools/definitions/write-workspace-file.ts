import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { WriteWorkspaceFileInputSchema } from '../schemas/schemas-workspace.js';

// First mutation tool: writes/creates a workspace file. riskCategory 'edit' so
// the Phase 1 permission engine gates it when enforcement is on.
export const writeWorkspaceFile = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Write or create a UTF-8 file in a chosen open workspace root (overwrites existing content; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval). bytesWritten confirms it landed; skip re-reading',
  id: 'brainstrike.writeWorkspaceFile',
  inputSchema: effectToolInputSchema(WriteWorkspaceFileInputSchema),
  kind: 'desktop',
  returns:
    'Write result: the normalized workspace path, bytesWritten, and created (true when a new file was created, false when an existing file was overwritten)',
  surfaces: ['desktop', 'web'],
});
