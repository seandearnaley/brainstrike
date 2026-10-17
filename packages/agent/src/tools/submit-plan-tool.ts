import { NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { SubmitPlanResumeSchema } from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import type { HostToolDefinition, HostToolExecutionContext } from '../host-tool-definition';
import { SubmitPlanInputSchema } from './schemas';

export const SUBMIT_PLAN_TOOL_ID = NATIVE_TOOL_ID.submitPlan;

/** The host owns plan suspension, decision validation and resumption. */
export function createSubmitPlanTool() {
  return {
    description: TOOL_DESCRIPTIONS[SUBMIT_PLAN_TOOL_ID],
    execute: async (_input: unknown, context?: HostToolExecutionContext) => {
      const resume = context?.resumeData;
      if (
        !(
          resume &&
          typeof resume === 'object' &&
          'action' in resume &&
          (resume.action === 'approved' || resume.action === 'rejected')
        )
      ) {
        throw new Error('submitPlan requires the host-validated decision');
      }
      const feedback = 'feedback' in resume ? resume.feedback : undefined;
      if (feedback !== undefined && typeof feedback !== 'string') {
        throw new Error('submitPlan received an invalid feedback value');
      }
      return { status: resume.action, ...(feedback === undefined ? {} : { feedback }) };
    },
    id: SUBMIT_PLAN_TOOL_ID,
    inputSchema: SubmitPlanInputSchema,
    resumeSchema: SubmitPlanResumeSchema,
  } satisfies HostToolDefinition;
}
