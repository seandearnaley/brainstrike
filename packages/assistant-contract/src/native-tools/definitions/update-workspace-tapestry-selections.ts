import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { UpdateWorkspaceTapestrySelectionsInputSchema } from '../schemas/schemas-workspace.js';

export const updateWorkspaceTapestrySelections = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 190,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'edit',
  },
  description:
    'Create, update, or clear token-aware Tapestry line ranges for selected workspace context files',
  discovery: { family: 'workspace context and tapestry', namespace: 'context' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    updates:
      'Per-file range updates: each item has path and ranges with startLine/endLine/isActive',
  },
  id: 'brainstrike.updateWorkspaceTapestrySelections',
  inputSchema: providerCompatibleInputSchema(UpdateWorkspaceTapestrySelectionsInputSchema),
  kind: 'desktop',
  returns: 'Tapestry update result with applied and skipped file metadata',
  surfaces: ['desktop', 'web'],
});
