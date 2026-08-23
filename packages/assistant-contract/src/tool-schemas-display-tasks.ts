/**
 * Task Tool Schema Display Metadata
 *
 * Browser-safe parameter definitions for native task and planning tools.
 */

import type { NativeToolId } from './native-tool-catalog.js';
import type { ToolSchemaDisplay } from './tool-schemas-display-types.js';

export const TASK_TOOL_SCHEMAS = {
  'brainstrike.askUser': {
    description:
      'Ask the user a clarifying question and wait for their answer; the run pauses until they respond. Provide options for a structured choice (set selectionMode to multi_select to allow several), or omit options for a free-text question.',
    parameters: [
      {
        description: 'The clear, specific question to ask the user.',
        maxLength: 2000,
        minLength: 1,
        name: 'question',
        required: true,
        type: 'string',
      },
      {
        arrayItemType: 'object',
        description:
          'Optional choices; each has a label and optional description. Omit for free-text.',
        max: 10,
        name: 'options',
        required: false,
        type: 'array',
      },
      {
        description:
          'How many options the user may pick. Requires options; defaults to single_select.',
        enumValues: ['single_select', 'multi_select'],
        name: 'selectionMode',
        required: false,
        type: 'enum',
      },
    ],
    returns: "The user's answer as a string (multi-select answers are comma-joined).",
    toolId: 'brainstrike.askUser',
  },

  'brainstrike.manageTaskList': {
    description:
      'Record and update a structured plan for the current thread as a task list. Whole-list replace: pass the full desired list every call. Keep exactly one task in_progress and mark tasks completed as you finish them. The list is re-injected into your instructions each turn and shown to the user as a progress checklist.',
    parameters: [
      {
        arrayItemType: 'object',
        description:
          'The full task list to store (whole-list replace). Each item is { content (imperative label), activeForm (present-tense in-progress label), status: pending | in_progress | completed }. Maximum 50 tasks.',
        max: 50,
        name: 'tasks',
        required: true,
        type: 'array',
      },
    ],
    returns:
      'The stored tasks (with stable server-assigned ids) and a summary of counts by status (total, completed, inProgress, pending)',
    toolId: 'brainstrike.manageTaskList',
  },

  'brainstrike.submitPlan': {
    description:
      'Submit a structured implementation plan for the user to Approve or Reject. The run pauses until the user responds; on rejection their feedback is returned so you can revise and submit again.',
    parameters: [
      {
        description: 'Short title for the plan.',
        maxLength: 300,
        minLength: 1,
        name: 'title',
        required: true,
        type: 'string',
      },
      {
        description: 'One or two paragraphs summarizing the plan and its goal.',
        maxLength: 4000,
        minLength: 1,
        name: 'overview',
        required: true,
        type: 'string',
      },
      {
        arrayItemType: 'object',
        description: 'Ordered implementation steps; each has a title and optional detail.',
        max: 30,
        name: 'steps',
        required: true,
        type: 'array',
      },
      {
        description: 'Optional risks, tradeoffs, or things that could go wrong.',
        maxLength: 4000,
        name: 'risks',
        required: false,
        type: 'string',
      },
      {
        description: 'Optional how-to-verify: tests, checks, or acceptance criteria.',
        maxLength: 4000,
        name: 'verification',
        required: false,
        type: 'string',
      },
    ],
    returns:
      "The user's decision: status approved or rejected, plus optional feedback on rejection.",
    toolId: 'brainstrike.submitPlan',
  },
} satisfies Partial<Record<NativeToolId, ToolSchemaDisplay>>;
