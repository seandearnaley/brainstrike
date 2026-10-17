import {
  NATIVE_TOOL_ID,
  type SubmitPlanDecision,
  type SubmitPlanPayload,
} from '@brainstrike/assistant-contract';
import {
  SubmitPlanResumeSchema,
  standardInputSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { TOOL_DESCRIPTIONS } from '@brainstrike/assistant-contract/tool-metadata';
import { createTool } from '@mastra/core/tools';
import { Schema } from 'effect';
import { SubmitPlanInputSchema } from './schemas';

export const SUBMIT_PLAN_TOOL_ID = NATIVE_TOOL_ID.submitPlan;

const SubmitPlanSuspendSchema = Schema.Struct({
  overview: Schema.String,
  risks: Schema.optional(Schema.String),
  steps: Schema.mutable(
    Schema.Array(Schema.Struct({ detail: Schema.optional(Schema.String), title: Schema.String }))
  ),
  title: Schema.String,
  verification: Schema.optional(Schema.String),
});

const SubmitPlanOutputSchema = Schema.Struct({
  feedback: Schema.optional(Schema.String),
  status: Schema.Literals(['approved', 'rejected']),
});

/**
 * `submitPlan` — a SUSPENDING native tool. It pauses the run via the Mastra
 * agent-native `suspend()` primitive, carrying the structured plan INLINE (no
 * on-disk artifact, unlike the Mastra builtin `submit_plan`). The host renders
 * an approve/reject UI and resumes with a {@link SubmitPlanDecision}; the tool
 * re-runs with `context.agent.resumeData` set and reports the decision back to
 * the model (rejection feedback flows back so the model can revise).
 *
 * riskCategory is 'read' (see NATIVE_TOOL_DEFAULTS): its OWN suspension is the
 * user gate, so the permission engine must NOT stack an approval prompt on top.
 */
export function createSubmitPlanTool() {
  return createTool({
    description: TOOL_DESCRIPTIONS[SUBMIT_PLAN_TOOL_ID],
    execute: async (input, context) => {
      const resume = (context?.resumeData ?? context?.agent?.resumeData) as
        | SubmitPlanDecision
        | undefined;
      if (resume !== undefined) {
        return {
          status: resume.action,
          ...(resume.feedback ? { feedback: resume.feedback } : {}),
        };
      }
      const suspend = context?.agent?.suspend;
      const payload: SubmitPlanPayload = {
        overview: input.overview,
        // Strip `undefined` optional fields (exactOptionalPropertyTypes).
        steps: input.steps.map((step) =>
          step.detail === undefined
            ? { title: step.title }
            : { detail: step.detail, title: step.title }
        ),
        title: input.title,
        ...(input.risks ? { risks: input.risks } : {}),
        ...(input.verification ? { verification: input.verification } : {}),
      };
      if (suspend) {
        await suspend(payload);
        return;
      }
      // Direct invocation outside an agent run (no suspend context): surface the
      // plan as a readable status rather than throwing (mirrors the builtin).
      return {
        feedback: `Plan submitted (no interactive approval available): ${input.title}`,
        status: 'rejected' as const,
      };
    },
    id: SUBMIT_PLAN_TOOL_ID,
    inputSchema: SubmitPlanInputSchema,
    outputSchema: standardInputSchema(SubmitPlanOutputSchema, {
      jsonSchemaOnExcessProperty: 'error',
      onExcessProperty: 'ignore',
    }),
    resumeSchema: SubmitPlanResumeSchema,
    suspendSchema: standardInputSchema(SubmitPlanSuspendSchema, {
      jsonSchemaOnExcessProperty: 'error',
      onExcessProperty: 'ignore',
    }),
  });
}
