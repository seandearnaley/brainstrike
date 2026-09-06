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
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    root: 'Folder name or id to read from when multiple folders are open (omit when one). Requires explicit filePaths — the selected-context default only applies to the focused folder.',
  },
  history: { staleReplayable: true },
  id: 'brainstrike.readWorkspaceContext',
  inputSchema: providerCompatibleInputSchema(ReadWorkspaceContextInputSchema),
  kind: 'desktop',
  returns:
    'Included file contents plus explicit skipped-file, truncation, and approximate token metadata',
  surfaces: ['desktop', 'web'],
});
