import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { WebExtractInputSchema } from '../schemas/schemas-search.js';

// The natural pair to webSearch (report R5): read the page BEHIND a result
// or a user-pasted URL as markdown, via Tavily's /extract endpoint. Same
// 'read' + no-approval posture and the same external-service privacy caveat
// — the URLs are sent to Tavily. Model-supplied URLs are validated
// server-side first (http/https only, no credentials, no private/loopback/
// link-local hosts) so an internal URL never leaves the machine.
export const webExtract = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Fetch the readable content of up to 5 public web pages as markdown (the natural follow-up to webSearch results, or for a user-pasted URL). SENDS THE URLS TO AN EXTERNAL EXTRACTION SERVICE (Tavily); refuses non-http(s), credentialed, and private/internal URLs before anything is sent. Preserves complete source content; larger results provide an exact brainstrike.readToolOutputArtifact continuation cursor. Returns a clear "unavailable" message (not an error) when no Tavily key is configured',
  discovery: { family: 'web search/extract', namespace: 'web' },
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.webExtract',
  inputSchema: providerCompatibleInputSchema(WebExtractInputSchema),
  kind: 'desktop',
  returns:
    'Complete per-URL extracted markdown content plus exact URLs and a per-URL failed list (refused/unreachable URLs with exact reasons). Larger results provide an exact brainstrike.readToolOutputArtifact continuation cursor instead of clipping or re-fetching. When no Tavily key is configured, an available: false result with an actionable message. On error/timeout, a non-fatal error result (the run continues).',
  surfaces: ['desktop', 'web'],
});
