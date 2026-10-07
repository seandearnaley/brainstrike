/** Node composition borrows the shipped tool pipeline without registering browser inference. */

export { formatSkillsCatalog } from '@mastra/core/processors';
export { DEFAULT_AGENT_MAX_STEPS } from './agent-loop-defaults';
export {
  buildContextBudgetNote,
  buildCurrentDateNote,
  buildDefaultInstructions,
  buildLocalDefaultInstructions,
} from './mastra/default-instructions';
export { applyToolModelOutputProjections } from './mastra/tool-model-output';
export { createSanitizedToolNameMap } from './mastra/tool-sanitizer';
export {
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
} from './stream/tool-output-limits';
export { guardToolExecution } from './tools/guard-tool-execution';
export type { RuntimeData } from './types';
