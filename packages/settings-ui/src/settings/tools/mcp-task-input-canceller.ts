import type {
  McpElicitationPresentationWire,
  McpTaskBridge,
} from '@brainstrike/assistant-contract';
/**
 * Cancels the task a task-bound input belongs to (tasks/cancel), which differs from
 * cancelling the input itself. Both MCP input presenters share it.
 */
export function mcpTaskInputCanceller(
  presentation: Pick<McpElicitationPresentationWire, 'provenance'>,
  taskBridge: McpTaskBridge | null
): (() => Promise<void>) | undefined {
  const handle = presentation.provenance.taskHandle;
  if (!(handle && taskBridge)) {
    return;
  }
  return async () => {
    const outcome = await taskBridge.act({ action: 'cancel', handle });
    if (!outcome.ok) {
      throw new Error(outcome.diagnostic.message);
    }
    if (outcome.task.status !== 'cancelled') {
      throw new Error('MCP task cancellation did not observe a cancelled task.');
    }
  };
}
