import { defineNativeTool } from '../define.js';
import { AskUserInputSchema } from '../schemas/schemas-tasks.js';

// Suspending tool: asks the user a question and PAUSES the run for their
// answer. `category:'action'` is the UI/load taxonomy, but the risk bucket is
// EXPLICITLY 'read' — its OWN suspension is the user gate, so the permission
// engine must NOT stack an approval prompt on top (that would double-gate it).
// It mutates no workspace/fs/persistent-user state. An `action` tool MUST
// declare riskCategory explicitly (tool-risk.ts throws otherwise).
export const askUser = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 120,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Ask the user a clarifying question and WAIT for their answer (the run pauses). Provide options for a structured choice (selectionMode multi_select allows several), or omit options for a free-text question',
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    options: 'Optional choices; each has a label and optional description. Omit for free-text.',
  },
  id: 'brainstrike.askUser',
  // Already wrapped in providerCompatibleInputSchema at its declaration: the
  // suspending-tool factory (`createAskUserTool`) registers this exact object.
  inputSchema: AskUserInputSchema,
  kind: 'desktop',
  returns: "The user's answer as a string (multi-select answers are comma-joined).",
  surfaces: ['desktop', 'web'],
});
