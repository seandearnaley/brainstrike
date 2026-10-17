import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { ReadWorkspaceDirectoryInputSchema } from '../schemas/schemas-workspace.js';

export const readWorkspaceDirectory = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description: 'List a workspace directory in a compact, token-efficient format',
  discovery: { family: 'directory listings', namespace: 'context' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.readWorkspaceDirectory',
  inputSchema: effectToolInputSchema(ReadWorkspaceDirectoryInputSchema),
  kind: 'desktop',
  returns:
    'Compact entries (self-bounded to the tool output budget) with totals, truncation flag, and a continuation hint',
  surfaces: ['desktop', 'web'],
});
