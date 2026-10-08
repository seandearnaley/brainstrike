import { retainHostRunWork } from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';
import { jsonValue } from './json-value.js';
import type { HostMcpInputState } from './mcp-input-state.js';
import type { HostTool } from './ports.js';
import type { HostEvent, HostLogRow } from './protocol.js';
import { hostRunTools } from './run-admission.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;

/** HostCore's thread-scoped writer and admission, lent to one tool effect. */
export interface HostToolEffectPort {
  admit<T>(perform: () => Promise<T>): Promise<T>;
  append(
    events: readonly HostEvent[],
    durability?: 'normal' | 'full',
    beforePublish?: (rows: readonly HostLogRow[]) => void
  ): Promise<HostLogRow[]>;
  fold(row: HostLogRow): void;
  readonly mcpInputs: HostMcpInputState;
  /** Host closing or thread deletion retires the run's MCP execution authority. */
  retired(): boolean;
}

/** Commits the effect's intent, then runs its admitted executor exactly once. */
export async function performHostToolEffect(
  run: HostRunState,
  action: Action,
  registered: HostTool,
  input: unknown,
  resumeData: unknown,
  port: HostToolEffectPort
): Promise<unknown> {
  await port.append([action]);
  run.started.add(action.toolCallId);
  run.controller.signal.throwIfAborted();
  // The public SDK already validated/transformed this exact admitted input.
  // Revalidating a canonical value can transform it a second time.
  return await registered.execute(input, {
    ...(resumeData === undefined ? {} : { resumeData }),
    mcp: port.mcpInputs.execution(run, action, registered, {
      admit: (perform) => port.admit(perform),
      append: (events, beforePublish) =>
        port.append(events, 'full', (rows) => {
          for (const row of rows) {
            port.fold(row);
          }
          beforePublish?.();
        }),
      assertCurrent: () => {
        if (port.retired() || hostRunTools(run)[action.toolId] !== registered) {
          throw new Error('MCP execution authority retired');
        }
      },
      retain: (work) => retainHostRunWork(run, work),
    }),
    runId: run.id,
    signal: run.controller.signal,
    threadId: run.threadId,
    toolCallId: action.toolCallId,
    write: async (chunk: unknown): Promise<void> => {
      run.controller.signal.throwIfAborted();
      await port.append([{ chunk: jsonValue(chunk), runId: run.id, type: 'stream.chunk' }]);
    },
  });
}
