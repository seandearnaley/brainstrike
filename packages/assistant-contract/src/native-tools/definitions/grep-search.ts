import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { GrepSearchInputSchema } from '../schemas/schemas-search.js';

export const grepSearch = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 160,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  description:
    "Grep indexed and live on-disk file content for an exact string or regex. Default 'files' mode surveys matching paths cheaply; 'content' mode (scoped with filePaths) returns matches grouped under one file header per file — 'root:path' when several folders are open — with 'line: text' rows ('-' marks opt-in context rows). Reuse that root and path (and the row's line number as startLine) in readWorkspaceFile calls",
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.grepSearch',
  inputSchema: providerCompatibleInputSchema(GrepSearchInputSchema),
  kind: 'desktop',
  localProvider: 'offered',
  returns:
    "'files' mode: matching file paths with per-file match counts. 'content' mode: path, 1-based line, line text, and context lines. Both self-bound to the tool output budget with totals, truncation flags, and a continuation hint",
  surfaces: ['desktop', 'web'],
});
