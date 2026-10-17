import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { WebSearchInputSchema } from '../schemas/schemas-search.js';

// Read-only web retrieval via Tavily. riskCategory 'read' + requiresApproval
// false: it does NOT mutate workspace state, so the permission engine allows
// it by default like the other readers. NOTE the privacy caveat documented on
// the tool description: it sends the query to an EXTERNAL service (Tavily).
export const webSearch = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Search the web for current docs, APIs, error messages, and library usage. SENDS YOUR QUERY TO AN EXTERNAL WEB-SEARCH SERVICE (the model provider\'s built-in search when available, otherwise Tavily). Returns a clear "unavailable" message (not an error) when no provider-native search and no Tavily key are configured',
  discovery: { family: 'web search/extract', namespace: 'web' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.webSearch',
  inputSchema: effectToolInputSchema(WebSearchInputSchema),
  kind: 'desktop',
  returns:
    'A list of results (title, url, snippet) self-bound to the tool output budget, with a truncation flag and continuation hint. When neither a provider-native search nor a Tavily key is available, an available: false result with an actionable message. On error/timeout, a non-fatal error result (the run continues).',
  surfaces: ['desktop', 'web'],
});
