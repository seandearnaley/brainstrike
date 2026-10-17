import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { StringReplaceWorkspaceFileInputSchema } from '../schemas/schemas-workspace.js';

// Surgical-edit complement to writeWorkspaceFile: fuzzy-matches an oldStr
// block and replaces it. Same edit-risk gating.
export const stringReplaceWorkspaceFile = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 160,
    loadingTier: 'critical',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Surgically edit a file in a chosen open workspace root by replacing one oldStr block with newStr (fuzzy-matched; refuses ambiguous matches; refuses if the file changed on disk since you last read it — re-read and retry; workspace-scoped, requires approval). matchType "exact" confirms verbatim placement; other matchTypes are fuzzy — re-read for precision',
  id: 'brainstrike.stringReplaceWorkspaceFile',
  inputSchema: effectToolInputSchema(StringReplaceWorkspaceFileInputSchema),
  kind: 'desktop',
  localProvider: 'offered',
  returns:
    'Edit result: the normalized workspace path, bytesWritten, matchType (which cascade branch matched), and replaced: true',
  surfaces: ['desktop', 'web'],
});
