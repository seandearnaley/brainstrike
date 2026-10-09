import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { GlobWorkspaceInputSchema } from '../schemas/schemas-search.js';

// Read-only file enumeration by glob pattern. Explicitly pinned to the 'read'
// risk bucket (it is also derivable from retrieval + no-approval) so the
// permission engine allows it by default, like the other workspace readers.
export const globWorkspace = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 130,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Enumerate workspace files whose path matches a glob (e.g. **/*.test.ts, src/**/*.tsx). One path per result line, prefixed with its root name when several folders are open. Excludes .git, build output, and gitignored paths by default; pass includeIgnored to see them; read-only',
  history: { recencyPrunable: true, staleReplayable: true },
  id: 'brainstrike.globWorkspace',
  inputSchema: providerCompatibleInputSchema(GlobWorkspaceInputSchema),
  kind: 'desktop',
  localProvider: 'offered',
  returns:
    'Matching workspace-relative paths (each labelled with its root), self-bound to the tool output budget, with totals, a truncation flag, and a continuation hint',
  surfaces: ['desktop', 'web'],
});
