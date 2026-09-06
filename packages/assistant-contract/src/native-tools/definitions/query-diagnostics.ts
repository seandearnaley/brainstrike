import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { QueryDiagnosticsInputSchema } from '../schemas/schemas-diagnostics.js';

// Read-only, bounded access to the local diagnostic event store. Explicitly
// pinned because it reads application-internal failure context rather than
// workspace files, and must remain available under the normal read policy
// without being mistaken for arbitrary self-query SQL.
export const queryDiagnostics = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 351,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Query Brainstrike durable diagnostic events without re-running the app. Use mode=events for newest matching rows or mode=fingerprints to group recurring failures. Filters are exact severity/fingerprint/run/thread plus an inclusive ISO time window; results are hard-capped and output-budget truncation is explicit. Read-only',
  discovery: { family: 'diagnostics', namespace: 'database' },
  history: { recencyPrunable: true },
  id: 'brainstrike.queryDiagnostics',
  inputSchema: providerCompatibleInputSchema(QueryDiagnosticsInputSchema),
  kind: 'desktop',
  returns:
    'Bounded newest diagnostic rows or recurring fingerprint groups with explicit cap/output truncation metadata',
  surfaces: ['desktop'],
});
