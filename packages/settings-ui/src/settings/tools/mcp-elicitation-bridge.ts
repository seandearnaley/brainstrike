/**
 * Capability resolution for the desktop `window.mcp` elicitation members
 * (BST-1584). Lives beside the host so the component module exports only the
 * component (react-refresh) and so tests can pin the required-member set.
 */
import type {
  McpElicitationPresentationWire,
  McpElicitationRetiredWire,
  McpElicitationSettlement,
  McpTaskBridge,
} from '@brainstrike/assistant-contract';

export interface McpElicitationBridge {
  readonly onElicitationRequested: (
    callback: (presentation: McpElicitationPresentationWire) => void
  ) => () => void;
  readonly onElicitationRetired: (
    callback: (retired: McpElicitationRetiredWire) => void
  ) => () => void;
  readonly settleElicitation: (settlement: McpElicitationSettlement) => Promise<void>;
}

/** The existing fenced task-control capability, distinct from input settlement. */
export function resolveMcpTaskInputBridge(): McpTaskBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { mcp?: { tasks?: Partial<McpTaskBridge> } }).mcp?.tasks;
  if (!candidate) {
    return null;
  }
  return (['act', 'list', 'onStatusChanged'] as const).every(
    (method) => typeof candidate[method] === 'function'
  )
    ? (candidate as McpTaskBridge)
    : null;
}

const BRIDGE_METHODS = [
  'onElicitationRequested',
  'onElicitationRetired',
  'settleElicitation',
] as const satisfies readonly (keyof McpElicitationBridge)[];

/** Resolve the elicitation members of `window.mcp`, or `null` when any is absent. */
export function resolveMcpElicitationBridge(): McpElicitationBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const candidate = (window as Window & { mcp?: Partial<McpElicitationBridge> }).mcp;
  if (!candidate) {
    return null;
  }
  return BRIDGE_METHODS.every((method) => typeof candidate[method] === 'function')
    ? (candidate as McpElicitationBridge)
    : null;
}

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
