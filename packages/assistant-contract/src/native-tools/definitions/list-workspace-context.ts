import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ListWorkspaceContextInputSchema } from '../schemas/schemas-workspace.js';

export const listWorkspaceContext = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Inspect open workspace roots, the Main operating-root path, Focused-root selected context, and workspace index hint without reading file contents; compact summary by default, detail: true for per-file Tapestry ranges',
  discovery: { family: 'workspace context and tapestry', namespace: 'context' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.listWorkspaceContext',
  inputSchema: providerCompatibleInputSchema(ListWorkspaceContextInputSchema),
  kind: 'desktop',
  returns:
    'Open workspace roots (workspaceRoots: name + id + path), the main root path, selected paths, selected count, workspace index hint, and optional metadata',
  surfaces: ['desktop', 'web'],
});
