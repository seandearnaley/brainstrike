import { defineNativeTool } from '../define.js';
import { SubmitPlanInputSchema } from '../schemas/schemas-tasks.js';

// Suspending tool: submits a structured plan and PAUSES for the user's
// approve/reject decision. Risk bucket EXPLICITLY 'read' for the same reason as
// askUser — its own suspension is the gate; do NOT let the permission engine
// double-gate it with an approval prompt.
export const submitPlan = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'critical',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Submit a structured implementation plan (title, overview, ordered steps, optional risks/verification) for the user to Approve or Reject. The run PAUSES until they respond; rejection feedback is returned so you can revise and resubmit',
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    steps: 'Ordered implementation steps; each has a title and optional detail.',
  },
  id: 'brainstrike.submitPlan',
  inputSchema: SubmitPlanInputSchema,
  kind: 'desktop',
  localProvider: 'unregistered',
  returns: "The user's decision: status approved or rejected, plus optional feedback on rejection.",
  surfaces: ['desktop', 'web'],
});
