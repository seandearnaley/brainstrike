/** Native integration fixtures consume the production projection, never a parallel mapper. */
export { Agent, type DelegationStartContext } from '@mastra/core/agent';
export { Mastra } from '@mastra/core/mastra';
export { createTool } from '@mastra/core/tools';
export {
  createAttemptDelegatedProjection,
  processMastraStreamPart,
} from '../mastra/agent-streaming';
export { readResumedApprovalToolCall } from '../mastra/attempt-legs';
export { projectBackgroundStream } from '../mastra/background-stream';
export { discoverDelegatedToolPause } from '../mastra/delegated-suspension-discovery';
export {
  assertDelegatedToolActionPending,
  claimDelegatedToolAction,
} from '../mastra/delegated-tool-actions';
export { createResponseBoundaryProcessor } from '../mastra/response-boundary-processor';
export { sanitizeTools } from '../tool-projection/tool-sanitizer';
export { createTurnAttemptLifecycleState } from '../mastra/turn-attempts';
