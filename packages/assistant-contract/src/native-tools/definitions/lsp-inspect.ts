import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { LspInspectInputSchema } from '../schemas/schemas-search.js';

// Semantic code inspection at a cursor (report R2 Phase B): hover type,
// line diagnostics, definition, and implementation via a bundled language
// server. Read-only (no mutation), so 'read' risk + no approval like the
// other workspace readers. Desktop-only (spawns a server child process);
// web omits it.
export const lspInspect = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 160,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "LSP (Language Server Protocol) semantic code inspection for TypeScript/JavaScript: the inferred TYPE (hover), line diagnostics, the symbol's DEFINITION location, and its IMPLEMENTATIONS. Give the file path, 1-based line, and `match`: prefer the unique identifier itself (for example `computeTotal`); when it repeats on that line, pass a unique line fragment with exactly one `<<<` immediately before the intended occurrence. Wrong-line identifiers return bounded candidate lines for an explicit retry; ambiguous targets never guess. Read-only; returns a clear 'unavailable' note (not an error) for unsupported file types or when no server is available",
  discovery: { family: 'symbol and LSP inspection', namespace: 'semantics' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    match:
      'Prefer the unique identifier itself, e.g. `computeTotal` (cursor at its first character). If it repeats on the line, use a unique fragment with exactly one `<<<` before the intended occurrence, e.g. `const total = <<<computeTotal(items)`',
  },
  history: { recencyPrunable: true },
  id: 'brainstrike.lspInspect',
  inputSchema: providerCompatibleInputSchema(LspInspectInputSchema),
  kind: 'desktop',
  returns:
    'Up to four groups: hover (type/docs), diagnostics (the inspected line), definition (declaration locations with a one-line preview), and implementation (usage/implementation locations). An available:false note for unsupported file types or when no server is available.',
  surfaces: ['desktop', 'web'],
});
