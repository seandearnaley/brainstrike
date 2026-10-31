import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { ListWorkspaceContextInputSchema } from '../schemas/schemas-workspace.ts';

export const listWorkspaceContext = defineNativeTool({
  activity: {
    active: 'Listing context',
    done: 'Listed context',
    family: 'read',
    request: 'List context',
  },
  defaults: {
    category: 'retrieval',
    estimatedTokens: 120,
    loadingTier: 'deferred',
    requiresApproval: false,
  },
  description:
    'Inspect open workspace roots, the Main operating-root path, and the workspace index hint without reading file contents',
  discovery: { family: 'workspace context', namespace: 'context' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.listWorkspaceContext',
  inputSchema: effectToolInputSchema(ListWorkspaceContextInputSchema),
  kind: 'desktop',
  returns:
    'Open workspace roots (workspaceRoots: name + id + path), the main root path, and the workspace index hint',
  surfaces: ['desktop', 'web'],
});
