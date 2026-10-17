import {
  type AskUserAnswer,
  type AskUserPayload,
  type AskUserResumeData,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import {
  AskUserResumeSchema,
  standardInputSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { Schema } from 'effect';
import { AskUserInputSchema } from './schemas';

export const ASK_USER_TOOL_ID = NATIVE_TOOL_ID.askUser;

const AskUserSuspendSchema = Schema.Struct({
  options: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({ description: Schema.optional(Schema.String), label: Schema.String })
      )
    )
  ),
  question: Schema.String,
  selectionMode: Schema.optional(Schema.Literals(['single_select', 'multi_select'])),
});

const AskUserOutputSchema = Schema.Struct({ answer: Schema.String });

/**
 * Join a multi-select answer into a compact model-facing string; single-select
 * and free-text answers already arrive as one string. Ported from the Mastra
 * builtin `formatQuestionAnswer` (`ask-user.d.ts`).
 */
export function formatAskUserAnswer(answer: AskUserAnswer): string {
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

function isAskUserAnswer(value: unknown): value is AskUserAnswer {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}

/**
 * Read the answer out of a resume payload: the canonical `{answer}` envelope
 * (extra keys such as the transport's `approved: true` rider are ignored), or
 * the legacy bare string/string[] from a pre-envelope suspended run. Any other
 * shape throws — Mastra validates resumes against the tool's resumeSchema, so
 * an unrecognized shape here is transport drift, never a user answer
 * (no-silent-fallbacks).
 */
export function readAskUserResumeAnswer(resumeData: unknown): AskUserAnswer {
  if (isAskUserAnswer(resumeData)) {
    return resumeData;
  }
  if (resumeData && typeof resumeData === 'object' && !Array.isArray(resumeData)) {
    const answer = (resumeData as Partial<AskUserResumeData>).answer;
    if (isAskUserAnswer(answer)) {
      return answer;
    }
  }
  throw new Error(
    'askUser resume payload matched neither the {answer} envelope nor the legacy string/string[] shape.'
  );
}

/**
 * `askUser` — a SUSPENDING native tool. It pauses the run via `suspend()` with a
 * question (+ optional options and selection mode); the host renders free-text /
 * single-select / multi-select UI and resumes with an {@link AskUserResumeData}
 * envelope (legacy bare {@link AskUserAnswer} resumes stay accepted). The
 * tool re-runs with `context.agent.resumeData` set and returns the answer to the
 * model. riskCategory is 'read' — its own suspension is the gate.
 */
export function createAskUserTool() {
  return createTool({
    description: TOOL_DESCRIPTIONS[ASK_USER_TOOL_ID],
    execute: async (input, context) => {
      const resume = context?.resumeData ?? context?.agent?.resumeData;
      if (resume !== undefined) {
        return { answer: formatAskUserAnswer(readAskUserResumeAnswer(resume)) };
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
    outputSchema: standardInputSchema(AskUserOutputSchema, {
      jsonSchemaOnExcessProperty: 'error',
      onExcessProperty: 'ignore',
    }),
    resumeSchema: AskUserResumeSchema,
    suspendSchema: standardInputSchema(AskUserSuspendSchema, {
      jsonSchemaOnExcessProperty: 'error',
      onExcessProperty: 'ignore',
    }),
  });
}
