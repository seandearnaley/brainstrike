import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { ReadWorkspaceDirectoryInputSchema } from '../schemas/schemas-workspace.ts';

export const readWorkspaceDirectory = defineNativeTool({
  activity: { active: 'Listing', done: 'Listed', family: 'read', request: 'List' },
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
