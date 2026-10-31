import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { FindWorkspaceSymbolInputSchema } from '../schemas/schemas-workspace.ts';

export const findWorkspaceSymbol = defineNativeTool({
  activity: { active: 'Inspecting', done: 'Inspected', family: 'search', request: 'Inspect' },
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
  inputSchema: effectToolInputSchema(FindWorkspaceSymbolInputSchema),
  kind: 'desktop',
  returns:
    'Matched symbols with best-effort enclosing 1-based line ranges and small preview snippets (no whole-file content)',
  surfaces: ['desktop', 'web'],
});
