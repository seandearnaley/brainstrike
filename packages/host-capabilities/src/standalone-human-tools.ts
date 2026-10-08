import {
  createAskUserTool,
  createSubmitPlanTool,
  type ScaledToolResultBudget,
} from '@brainstrike/agent/tool-runtime';
import { type AgentHostToolBindings, createAgentHostToolBindings } from '@brainstrike/agent-host';
import { NATIVE_TOOL_ID, resolveToolRiskCategory } from '@brainstrike/assistant-contract';
import { NATIVE_TOOL_REGISTRIES } from '@brainstrike/assistant-contract/tool-metadata';

export const STANDALONE_HUMAN_TOOL_IDS = [
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.submitPlan,
] as const;

/** Borrow the existing native constructors, registry identity and host binding. */
export function createStandaloneHumanTools(
  resolvedToolResultBudget: ScaledToolResultBudget
): AgentHostToolBindings {
  return createAgentHostToolBindings({
    bindings: Object.fromEntries(
      STANDALONE_HUMAN_TOOL_IDS.map((id) => {
        const definition = NATIVE_TOOL_REGISTRIES.byId[id];
        return [
          id,
          { identity: definition.id, risk: resolveToolRiskCategory(definition.defaults) },
        ];
      })
    ),
    resolvedToolResultBudget,
    tools: {
      [NATIVE_TOOL_ID.askUser]: createAskUserTool(),
      [NATIVE_TOOL_ID.submitPlan]: createSubmitPlanTool(),
    },
  });
}
