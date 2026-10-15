import { defineNativeTool } from '../define.js';
import { effectToolInputSchema } from '../schemas/effect-tool-input.js';
import { QueryDiagnosticsInputSchema } from '../schemas/schemas-diagnostics.js';

// Read-only, bounded access to the local diagnostic event store. Explicitly
// pinned because it reads application-internal failure context rather than
// workspace files, and must remain available under the normal read policy
// without being mistaken for arbitrary SQL.
export const queryDiagnostics = defineNativeTool({
  defaults: {
    category: 'analysis',
    estimatedTokens: 351,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Query Brainstrike retained desktop diagnostic logs without re-running the app. Older rotated-out events are unavailable. Use mode=events for newest matching rows or mode=fingerprints to group recurring failures. Filters are exact severity/fingerprint/run/thread plus an inclusive ISO time window; results are hard-capped and output-budget truncation is explicit. Read-only',
  discovery: { family: 'diagnostics', namespace: 'database' },
  history: { recencyPrunable: true },
  id: 'brainstrike.queryDiagnostics',
  inputSchema: effectToolInputSchema(QueryDiagnosticsInputSchema),
  kind: 'desktop',
  returns:
    'Bounded newest diagnostic rows or recurring fingerprint groups with explicit cap/output truncation metadata',
  surfaces: ['desktop'],
});
