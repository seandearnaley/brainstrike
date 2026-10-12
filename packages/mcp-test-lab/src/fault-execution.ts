export type McpLabFaultExecutionState =
  | 'unobserved'
  | 'observed'
  | 'active'
  | 'settled'
  | 'aborted';

export interface McpLabFaultExecution {
  finish(outcome: 'aborted' | 'settled'): void;
  waitForRelease?(signal?: AbortSignal): Promise<void>;
}

export interface McpLabFaultExecutionTracker {
  begin(faultId: string): McpLabFaultExecution;
  hold(faultId: string): () => void;
  observe(faultId: string): void;
  state(faultId: string): McpLabFaultExecutionState;
}

export function createMcpLabFaultExecutionTracker(
  faultIds: readonly string[]
): McpLabFaultExecutionTracker {
  const holds = new Map<string, Promise<void>>();
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
      const hold = holds.get(faultId);
      return Object.freeze({
        ...(hold
          ? {
              waitForRelease: async (signal?: AbortSignal): Promise<void> => {
                let abort: (() => void) | undefined;
                try {
                  await new Promise<void>((resolve, reject) => {
                    abort = () => {
                      const error = new Error(`MCP lab fault "${faultId}" hold was aborted`);
                      error.name = 'AbortError';
                      reject(error);
                    };
                    if (signal?.aborted) {
                      abort();
                      return;
                    }
                    signal?.addEventListener('abort', abort, { once: true });
                    void hold.then(resolve);
                  });
                } finally {
                  if (abort) {
                    signal?.removeEventListener('abort', abort);
                  }
                }
              },
            }
          : {}),
        finish(outcome: 'aborted' | 'settled') {
          if (finished) {
            throw new Error(`MCP lab fault "${faultId}" execution already finished`);
          }
          transition(faultId, 'active', outcome);
          finished = true;
          holds.delete(faultId);
        },
      });
    },
    hold(faultId: string): () => void {
      if (state(faultId) !== 'unobserved' || holds.has(faultId)) {
        throw new Error(`MCP lab fault "${faultId}" cannot acquire another execution hold`);
      }
      const held = Promise.withResolvers<void>();
      holds.set(faultId, held.promise);
      return () => held.resolve();
    },
    observe: (faultId: string) => transition(faultId, 'unobserved', 'observed'),
    state,
  });
}
