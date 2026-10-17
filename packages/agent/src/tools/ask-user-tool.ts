import {
  type AskUserAnswer,
  type AskUserResumeData,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { AskUserResumeSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import type { HostToolDefinition, HostToolExecutionContext } from '../host-tool-definition';
import { AskUserInputSchema } from './schemas';

export const ASK_USER_TOOL_ID = NATIVE_TOOL_ID.askUser;

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
 * shape throws — the host validates resumes against the tool's resumeSchema, so
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

/** The host owns question suspension, answer validation and resumption. */
export function createAskUserTool() {
  return {
    description: TOOL_DESCRIPTIONS[ASK_USER_TOOL_ID],
    execute: async (_input: unknown, context?: HostToolExecutionContext) => ({
      answer: formatAskUserAnswer(readAskUserResumeAnswer(context?.resumeData)),
    }),
    id: ASK_USER_TOOL_ID,
    inputSchema: AskUserInputSchema,
    resumeSchema: AskUserResumeSchema,
  } satisfies HostToolDefinition;
}
