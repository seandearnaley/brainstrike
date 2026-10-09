import type { McpHostTaskOwner } from '@brainstrike/assistant-contract';
import type { HostRunExecutionPorts } from './core-run-execution.js';
import { retainHostRunWork } from './core-run-lifecycle.js';
import type { HostMcpExecutionOwner } from './mcp-input-state.js';

/**
 * Core's ownership of the durable MCP tasks its runs bound (BST-1930 c3), for
 * the MCP runtime's recovery after a host restart. A recovered task's input is
 * committed to its run's thread through Core's writer and queue, and its
 * earlier answers are read from the same committed log.
 */
export function hostMcpTaskOwner(ports: HostRunExecutionPorts): McpHostTaskOwner {
  const ownerOf = (threadId: string, runId: string): HostMcpExecutionOwner | undefined => {
    const run = ports.runs.get(runId);
    if (run?.threadId !== threadId) {
      return undefined;
    }
    return {
      // The run itself is finished; its thread's command queue still orders these writes.
      admit: (perform) => ports.admit(threadId, perform, new AbortController().signal),
      append: (events, beforePublish) =>
        ports.append(threadId, events, 'full', (rows) => {
          ports.foldRows(rows);
          beforePublish?.();
        }),
      assertCurrent: () => {
        if (ports.retired(threadId)) {
          throw new Error('MCP task ownership retired');
        }
      },
      retain: (work) => retainHostRunWork(run, work),
    };
  };
  return {
    inputOutcome: (handle, inputKey) => ports.mcpInputs.inputOutcome(handle, inputKey),
    recover: (handle) => ports.mcpInputs.recover(handle, ownerOf),
  };
}
