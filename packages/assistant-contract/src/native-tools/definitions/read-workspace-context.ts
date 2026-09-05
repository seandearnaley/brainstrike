import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ReadWorkspaceContextInputSchema } from '../schemas/schemas-workspace.js';

export const readWorkspaceContext = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 180,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Read selected or explicit workspace files under strict file and token budgets after semantic search needs exact source',
  discovery: { family: 'workspace context and tapestry', namespace: 'context' },
  history: { staleReplayable: true },
  id: 'brainstrike.readWorkspaceContext',
  inputSchema: providerCompatibleInputSchema(ReadWorkspaceContextInputSchema),
  kind: 'desktop',
  returns:
    'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
  surfaces: ['desktop', 'web'],
});
