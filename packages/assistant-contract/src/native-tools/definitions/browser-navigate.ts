import { defineNativeTool } from '../define.ts';
import { effectToolInputSchema } from '../schemas/effect-tool-input.ts';
import { BrowserNavigateInputSchema } from '../schemas/schemas-browser.ts';

export const browserNavigate = defineNativeTool({
  activity: { active: 'Opening', done: 'Opened', family: 'web', request: 'Open' },
  defaults: {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    "Open a URL in your own tab of the app's embedded browser pane (never a tab the user opened) and wait for the load. The user approves each new site. Only public addresses and a localhost dev server load: another private-network or metadata URL fails as blocked_url, and a page that resolves or redirects to one fails as blocked_destination. Bare hosts get https://; non-URL text becomes a web search. Returns the final url and title",
  discovery: { family: 'browser pages', namespace: 'web' },
  id: 'brainstrike.browserNavigate',
  inputSchema: effectToolInputSchema(BrowserNavigateInputSchema),
  kind: 'desktop',
  returns: 'The final url and page title after the load settles',
  surfaces: ['desktop'],
});
