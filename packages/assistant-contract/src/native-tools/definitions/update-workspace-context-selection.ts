import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { UpdateWorkspaceContextSelectionInputSchema } from '../schemas/schemas-workspace.js';

export const updateWorkspaceContextSelection = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 150,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Bulk add, remove, or replace files selected in the workspace context explorer for reusable curated context',
  discovery: { family: 'workspace context and tapestry', namespace: 'context' },
  id: 'brainstrike.updateWorkspaceContextSelection',
  inputSchema: providerCompatibleInputSchema(UpdateWorkspaceContextSelectionInputSchema),
  kind: 'desktop',
  returns: 'Selection update result with applied and skipped paths',
  surfaces: ['desktop', 'web'],
});
