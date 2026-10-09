import { defineNativeTool } from '../define.js';
import { providerCompatibleInputSchema } from '../schemas/provider-compatible-input.js';
import { ManageTaskListInputSchema } from '../schemas/schemas-tasks.js';

// Whole-list replace of the assistant's own per-thread plan. `category:'action'`
// is the UI/load taxonomy, but the risk bucket is EXPLICITLY 'read': it mutates
// ONLY the assistant's ephemeral todo list — no workspace/fs/persistent-user
// state — so, like brainstrike.webSearch (also 'read' despite doing work), the
// permission engine allows it by default and the loop never suspends for a plan
// update. An `action` tool MUST declare riskCategory explicitly (tool-risk.ts
// throws otherwise — no silent bucketing).
export const manageTaskList = defineNativeTool({
  defaults: {
    category: 'action',
    estimatedTokens: 140,
    loadingTier: 'deferred',
    requiresApproval: false,
    riskCategory: 'read',
  },
  description:
    'Record and update a structured plan for the current thread as a task list (whole-list replace). Each task has content (imperative label), activeForm (present-tense in-progress label), and status pending/in_progress/completed. Keep exactly one task in_progress; mark tasks completed as you finish them. The list is re-shown to you every turn and rendered to the user as a progress checklist',
  discovery: { family: 'task lists', namespace: 'workspace' },
  // Inspector-only prose (never sent to the model); see toToolSchemaDisplay.
  display: {
    tasks:
      'The full task list to store (whole-list replace). Each item is { content (imperative label), activeForm (present-tense in-progress label), status: pending | in_progress | completed }. Maximum 50 tasks.',
  },
  id: 'brainstrike.manageTaskList',
  inputSchema: providerCompatibleInputSchema(ManageTaskListInputSchema),
  kind: 'desktop',
  localProvider: 'unregistered',
  returns:
    'The stored tasks (with stable server-assigned ids) and a summary of counts by status (total, completed, inProgress, pending)',
  surfaces: ['desktop', 'web'],
});
