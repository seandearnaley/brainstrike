import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
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
    "Open a URL in your own tab of the app's embedded browser pane (never a tab the user opened) and wait for the load. Only public addresses load: a loopback, private-network or metadata URL fails as blocked_url, and a page that resolves or redirects to one fails as blocked_destination. Bare hosts get https://; non-URL text becomes a web search. Returns the final url and title",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserNavigate',
  inputSchema: effectToolInputSchema(BrowserNavigateInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns: 'The final url and page title after the load settles',
  surfaces: ['desktop'],
});
