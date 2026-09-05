import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ReadWorkspaceFileInputSchema } from '../schemas/schemas-workspace.js';

// Core workspace reading tools
export const readWorkspaceFile = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: false,
  },
  description:
    'Read a file from a chosen open workspace root as bounded, line-numbered pages with a short thread-scoped continuation handle. For later pages pass only cursor (and optional maxChars); omit path/root/startLine/endLine',
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    root: 'Folder name or id to read from when multiple folders are open; omit on continuation to reuse the cursor-bound root',
  },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.readWorkspaceFile',
  inputSchema: providerCompatibleInputSchema(ReadWorkspaceFileInputSchema),
  kind: 'desktop',
  returns:
    'Line-numbered file page with exact source metadata, truncation status, and nextCursor (null when complete)',
  surfaces: ['desktop', 'web', 'local'],
});
