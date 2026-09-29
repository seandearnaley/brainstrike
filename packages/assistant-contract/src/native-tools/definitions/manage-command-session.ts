import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ManageCommandSessionInputSchema } from '../schemas/schemas-execution.js';

export const manageCommandSession = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 482,
    loadingTier: 'deferred',
    requiresApproval: true,
    riskCategory: 'execute',
  },
  description:
    'Start, write to, stop, or remove a persistent PTY command session in one open workspace root. Pass exactly one typed operation. Use this for servers and interactive commands that must outlive one tool call; use executeCommand for normal bounded commands. Arbitrary execution with no sandbox; requires approval by default',
  discovery: { family: 'command sessions', namespace: 'sessions' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    operation:
      'Exactly one operation: {action:"start", command, cwd?, cols?, rows?}, {action:"write", sessionId, data}, {action:"stop", sessionId}, or {action:"remove", sessionId}.',
  },
  id: 'brainstrike.manageCommandSession',
  inputSchema: providerCompatibleInputSchema(ManageCommandSessionInputSchema),
  kind: 'desktop',
  nonDurableOutput: true,
  returns:
    'Typed session state for start/stop/write, or an explicit removed result. Failures distinguish invalid input, unavailable roots, unknown/cross-root sessions, exited sessions, startup failure, and stop failure.',
  surfaces: ['desktop'],
});
