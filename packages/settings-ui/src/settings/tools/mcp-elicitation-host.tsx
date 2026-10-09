/**
 * App-wide host for MCP elicitation consent (BST-1584).
 *
 * Subscribes to the elicitation capability its host provides (the desktop's
 * agent host, BST-1930 c5c; web provides none and renders nothing — there is
 * no `isElectron()` check), queues the presentations it pushes (the presenter
 * allows up to 32 pending), and shows exactly one `McpElicitationDialog` at a
 * time, oldest first. Settlement goes back through `settleElicitation`;
 * `onElicitationRetired` marks the visible request dead (or silently drops a
 * queued one that was never shown) so a dialog can never wait on a request the
 * host has already finalized.
 */
import type { McpElicitationPresentationWire } from '@brainstrike/assistant-contract';
import { useEffect, useReducer, useRef } from 'react';
import { useMcpElicitationCapability } from './mcp-elicitation-capability';
import { McpElicitationDialog } from './mcp-elicitation-dialog';
import { mcpTaskInputCanceller } from './mcp-task-input-canceller';

interface HostState {
  readonly queue: readonly McpElicitationPresentationWire[];
  readonly retired: Readonly<Record<string, string>>;
}

type HostAction =
  | { readonly id: string; readonly type: 'remove' }
  | { readonly presentation: McpElicitationPresentationWire; readonly type: 'requested' }
  | {
      readonly code: string;
      readonly id: string;
      readonly settledLocally: boolean;
      readonly type: 'retired';
    };

const EMPTY_STATE: HostState = { queue: [], retired: {} };

function hostReducer(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'requested':
      return state.queue.some(({ id }) => id === action.presentation.id)
        ? state
        : { ...state, queue: [...state.queue, action.presentation] };
    case 'retired': {
      const index = state.queue.findIndex((entry) => entry.id === action.id);
      if (index < 0) {
        return state;
      }
      // The visible request stays open with an explanation; a queued request
      // nobody has seen (or one this window already settled) is dropped.
      if (index === 0 && !action.settledLocally) {
        return { ...state, retired: { ...state.retired, [action.id]: action.code } };
      }
      return { ...state, queue: state.queue.filter((entry) => entry.id !== action.id) };
    }
    case 'remove': {
      const { [action.id]: _dropped, ...retired } = state.retired;
      return { queue: state.queue.filter((entry) => entry.id !== action.id), retired };
    }
    default:
      return state;
  }
}

export function McpElicitationHost() {
  const { elicitation: bridge, tasks: taskBridge } = useMcpElicitationCapability();
  const [state, dispatch] = useReducer(hostReducer, EMPTY_STATE);
  const settledIds = useRef(new Set<string>());

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const disposeRequested = bridge.onElicitationRequested((presentation) => {
      dispatch({ presentation, type: 'requested' });
    });
    const disposeRetired = bridge.onElicitationRetired(({ code, id }) => {
      dispatch({ code, id, settledLocally: settledIds.current.delete(id), type: 'retired' });
    });
    return () => {
      disposeRequested();
      disposeRetired();
    };
  }, [bridge]);

  const current = state.queue[0];
  if (!(bridge && current)) {
    return null;
  }
  return (
    <McpElicitationDialog
      key={current.id}
      onCancelTask={mcpTaskInputCanceller(current, taskBridge)}
      onDismissRetired={() => dispatch({ id: current.id, type: 'remove' })}
      onSettle={async (settlement) => {
        // Mark before awaiting: main pushes the `already-settled` retirement
        // before the invoke resolves, and that event must not flip this dialog
        // into the retired state.
        settledIds.current.add(settlement.id);
        try {
          await bridge.settleElicitation(settlement);
        } catch (error) {
          settledIds.current.delete(settlement.id);
          throw error;
        }
        dispatch({ id: settlement.id, type: 'remove' });
      }}
      presentation={current}
      retiredCode={state.retired[current.id]}
      taskCancellationUnavailable={
        current.provenance.taskHandle !== undefined && taskBridge === null
      }
    />
  );
}
