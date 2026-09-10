/** Native integration fixtures consume the production projection, never a parallel mapper. */
export { Agent, type DelegationStartContext } from '@mastra/core/agent';
export { Mastra } from '@mastra/core/mastra';
export { createTool } from '@mastra/core/tools';
export {
  createAttemptDelegatedProjection,
  processMastraStreamPart,
} from '../mastra/agent-streaming';
export { createResponseBoundaryProcessor } from '../mastra/response-boundary-processor';
export { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';
