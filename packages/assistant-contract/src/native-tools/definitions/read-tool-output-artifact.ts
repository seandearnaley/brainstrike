import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ReadToolOutputArtifactCursorInputSchema } from '../schemas/schemas-artifacts.js';

export const readToolOutputArtifact = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 150,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description: 'Page/grep; never alter or recreate the cursor.',
  discovery: { family: 'tool-output artifacts', namespace: 'artifacts' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.readToolOutputArtifact',
  inputSchema: providerCompatibleInputSchema(ReadToolOutputArtifactCursorInputSchema),
  kind: 'desktop',
  returns:
    'A contiguous page, or compact grep-style matching lines with continuation whenever scanning or rendering is limited.',
  surfaces: ['desktop', 'web'],
});
