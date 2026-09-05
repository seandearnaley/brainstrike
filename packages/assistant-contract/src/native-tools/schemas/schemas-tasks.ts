import { z } from 'zod';
import { providerCompatibleInputSchema } from './provider-compatible-input.js';

// ============================================================================
// Manage Task List Tool Schema
// ============================================================================

const ManageTaskListItemSchema = z
  .object({
    activeForm: z
      .string()
      .min(1)
      .max(500)
      .describe('Present-tense in-progress label, e.g. "Implementing the parser"'),
    content: z
      .string()
      .min(1)
      .max(500)
      .describe('Imperative task label, e.g. "Implement the parser"'),
    status: z
      .enum(['pending', 'in_progress', 'completed'])
      .describe('Task status; keep exactly one task in_progress'),
  })
  .strict();

export const ManageTaskListInputSchema = z
  .object({
    tasks: z
      .array(ManageTaskListItemSchema)
      .max(50)
      .describe(
        'The full task list to store (whole-list replace — pass the entire desired list every call). Maximum 50 tasks.'
      ),
  })
  .strict();

export type ManageTaskListInput = z.infer<typeof ManageTaskListInputSchema>;

// ============================================================================
// Submit Plan Tool Schema (suspending tool)
// ============================================================================

const SubmitPlanStepSchema = z
  .object({
    detail: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional elaboration of the step (what/why/how).'),
    title: z.string().min(1).max(500).describe('Short imperative step title.'),
  })
  .strict();

export const SubmitPlanInputSchema = providerCompatibleInputSchema(
  z
    .object({
      overview: z
        .string()
        .min(1)
        .max(4000)
        .describe('One or two paragraphs summarizing the plan and its goal.'),
      risks: z
        .string()
        .max(4000)
        .optional()
        .describe('Optional risks, tradeoffs, or things that could go wrong.'),
      steps: z.array(SubmitPlanStepSchema).min(1).max(30).describe('Ordered implementation steps.'),
      title: z.string().min(1).max(300).describe('Short title for the plan.'),
      verification: z
        .string()
        .max(4000)
        .optional()
        .describe('Optional how-to-verify: tests, checks, or acceptance criteria.'),
    })
    .strict()
);

export type SubmitPlanInput = z.infer<typeof SubmitPlanInputSchema>;

// ============================================================================
// Ask User Tool Schema (suspending tool)
// ============================================================================

const AskUserOptionSchema = z
  .object({
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('Optional context for the option (does not change the answer value).'),
    label: z.string().min(1).max(500).describe('Option label; the value returned when chosen.'),
  })
  .strict();

export const AskUserInputSchema = providerCompatibleInputSchema(
  z
    .object({
      options: z
        .array(AskUserOptionSchema)
        .min(1)
        .max(10)
        .optional()
        .describe('Optional choices. Omit for a free-text question.'),
      question: z
        .string()
        .min(1)
        .max(2000)
        .describe('The clear, specific question to ask the user.'),
      selectionMode: z
        .enum(['single_select', 'multi_select'])
        .optional()
        .describe(
          'How many options the user may pick. Requires options; defaults to single_select.'
        ),
    })
    .strict()
);

export type AskUserInput = z.infer<typeof AskUserInputSchema>;
