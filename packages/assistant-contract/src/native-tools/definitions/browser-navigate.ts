import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { BrowserNavigateInputSchema } from '../schemas/schemas-browser.js';

export const browserNavigate = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "Open a URL in the app's embedded browser pane (creates a tab when none is open) and wait for the load. Bare hosts get https://; non-URL text becomes a web search. Returns the final url and title",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserNavigate',
  inputSchema: providerCompatibleInputSchema(BrowserNavigateInputSchema),
  kind: 'desktop',
  returns: 'The final url and page title after the load settles',
  surfaces: ['desktop'],
});
