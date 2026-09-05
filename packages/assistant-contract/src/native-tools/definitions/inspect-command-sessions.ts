import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { InspectCommandSessionsInputSchema } from '../schemas/schemas-execution.js';

export const inspectCommandSessions = defineNativeTool({
  defaults: {
    category: 'retrieval',
    estimatedTokens: 283,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'List persistent command sessions in one open workspace root, or read bounded incremental PTY output. Continue a truncated list with offset and output with nextCursor; use read cursor -1 to attach at the live tail without replay. Read-only and workspace-scoped; command text, stdin, cwd, and PTY output are redacted from durable history',
  discovery: { family: 'command sessions', namespace: 'sessions' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    operation:
      'Exactly one operation: {action:"list", offset?}, or {action:"read", sessionId, cursor?}.',
  },
  history: { recencyPrunable: true },
  id: 'brainstrike.inspectCommandSessions',
  inputSchema: providerCompatibleInputSchema(InspectCommandSessionsInputSchema),
  kind: 'desktop',
  // Command text, stdin, cwd, and PTY output are redacted from durable history.
  nonDurableOutput: true,
  returns:
    'For list: a compact page with totalSessions and nextOffset when truncated. For read: bounded output, nextCursor, availableEndCursor, remaining count, retained buffer boundary, and explicit replay-gap state.',
  surfaces: ['desktop'],
});
