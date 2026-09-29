export type McpLabFaultExecutionState =
  | 'unobserved'
  | 'observed'
  | 'active'
  | 'settled'
  | 'aborted';

export interface McpLabFaultExecution {
  finish(outcome: 'aborted' | 'settled'): void;
}

export interface McpLabFaultExecutionTracker {
  begin(faultId: string): McpLabFaultExecution;
  observe(faultId: string): void;
  state(faultId: string): McpLabFaultExecutionState;
}

export function createMcpLabFaultExecutionTracker(
  faultIds: readonly string[]
): McpLabFaultExecutionTracker {
  const states = new Map<string, McpLabFaultExecutionState>(
    faultIds.map((faultId) => [faultId, 'unobserved'])
  );
  const state = (faultId: string): McpLabFaultExecutionState => {
    const current = states.get(faultId);
    if (!current) {
      throw new Error(`Unknown MCP lab fault id: ${faultId}`);
    }
    return current;
  };
  const transition = (
    faultId: string,
    expected: McpLabFaultExecutionState,
    next: McpLabFaultExecutionState
  ): void => {
    const current = state(faultId);
    if (current !== expected) {
      throw new Error(`MCP lab fault "${faultId}" cannot transition from ${current} to ${next}`);
    }
    states.set(faultId, next);
  };
  return Object.freeze({
    begin(faultId: string): McpLabFaultExecution {
      transition(faultId, 'observed', 'active');
      let finished = false;
      return Object.freeze({
        finish(outcome: 'aborted' | 'settled') {
          if (finished) {
            throw new Error(`MCP lab fault "${faultId}" execution already finished`);
          }
          transition(faultId, 'active', outcome);
          finished = true;
        },
      });
    },
    observe: (faultId: string) => transition(faultId, 'unobserved', 'observed'),
    state,
  });
}
