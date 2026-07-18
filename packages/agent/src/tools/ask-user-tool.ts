import {
  type AskUserAnswer,
  type AskUserPayload,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AskUserInputSchema } from './schemas';

export const ASK_USER_TOOL_ID = NATIVE_TOOL_ID.askUser;

const AskUserSuspendSchema = z.object({
  options: z.array(z.object({ description: z.string().optional(), label: z.string() })).optional(),
  question: z.string(),
  selectionMode: z.enum(['single_select', 'multi_select']).optional(),
});

const AskUserResumeSchema = z.union([z.string(), z.array(z.string())]);

const AskUserOutputSchema = z.object({ answer: z.string() });

/**
 * Join a multi-select answer into a compact model-facing string; single-select
 * and free-text answers already arrive as one string. Ported from the Mastra
 * builtin `formatQuestionAnswer` (`ask-user.d.ts`).
 */
export function formatAskUserAnswer(answer: AskUserAnswer): string {
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

/**
 * `askUser` — a SUSPENDING native tool. It pauses the run via `suspend()` with a
 * question (+ optional options and selection mode); the host renders free-text /
 * single-select / multi-select UI and resumes with an {@link AskUserAnswer}. The
 * tool re-runs with `context.agent.resumeData` set and returns the answer to the
 * model. riskCategory is 'read' — its own suspension is the gate.
 */
export function createAskUserTool() {
  return createTool({
    description: TOOL_DESCRIPTIONS[ASK_USER_TOOL_ID],
    execute: async (input, context) => {
      const resume = context?.agent?.resumeData as AskUserAnswer | undefined;
      if (resume !== undefined) {
        return { answer: formatAskUserAnswer(resume) };
      }
      const resolvedSelectionMode = input.options?.length
        ? (input.selectionMode ?? 'single_select')
        : undefined;
      const suspend = context?.agent?.suspend;
      // Strip `undefined` optional fields (exactOptionalPropertyTypes).
      const options = input.options?.map((option) =>
        option.description === undefined
          ? { label: option.label }
          : { description: option.description, label: option.label }
      );
      const payload: AskUserPayload = {
        question: input.question,
        ...(options ? { options } : {}),
        ...(resolvedSelectionMode ? { selectionMode: resolvedSelectionMode } : {}),
      };
      if (suspend) {
        await suspend(payload);
        return;
      }
      // Direct invocation outside an agent run (no suspend context): surface the
      // question as a readable answer rather than throwing.
      const optionsText = input.options?.length
        ? ` Options: ${input.options.map((option) => option.label).join(', ')}`
        : '';
      return { answer: `[Question for user] ${input.question}${optionsText}` };
    },
    id: ASK_USER_TOOL_ID,
    inputSchema: AskUserInputSchema,
    outputSchema: AskUserOutputSchema,
    resumeSchema: AskUserResumeSchema,
    suspendSchema: AskUserSuspendSchema,
  });
}
