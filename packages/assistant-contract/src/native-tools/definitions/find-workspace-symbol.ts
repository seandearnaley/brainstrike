import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { FindWorkspaceSymbolInputSchema } from '../schemas/schemas-workspace.js';

export const findWorkspaceSymbol = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 150,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    "Locate a symbol's best-effort enclosing line range in a workspace file without returning whole-file content",
  discovery: { family: 'symbol and LSP inspection', namespace: 'semantics' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.findWorkspaceSymbol',
  inputSchema: providerCompatibleInputSchema(FindWorkspaceSymbolInputSchema),
  kind: 'desktop',
  returns:
    'Matched symbols with best-effort enclosing 1-based line ranges and small preview snippets (no whole-file content)',
  surfaces: ['desktop', 'web'],
});
