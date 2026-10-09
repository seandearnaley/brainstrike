import type { HostChildRuns } from './core-child-runs.js';
import type { HostRunState } from './core-state.js';
import type { HostClientOrigin, HostPlatform, HostRunAdmissionRequest } from './ports.js';
import type { HostParams, HostResults } from './protocol.js';
import { hostRunIntentRequest, hostRunReopenRequest } from './run-admission.js';

type MemoryRead = HostResults['thread/memory/read'];
type ActiveRun = Pick<
  HostRunState,
  'admission' | 'id' | 'modelId' | 'planMode' | 'snapshot' | 'terminal' | 'threadId'
>;

/** Core's state one read uses. A read takes no command queue slot and acquires nothing. */
export interface HostMemoryReadContext {
  readonly children: Pick<HostChildRuns, 'rootThread'>;
  readonly deletions: ReadonlyMap<string, unknown>;
  readonly origin: HostClientOrigin | undefined;
  readonly runs: ReadonlyMap<string, ActiveRun>;
  readonly threads: ReadonlySet<string>;
  readonly workspaces: {
    admissionBinding(threadId: string): Pick<HostRunAdmissionRequest, 'workspaceBinding'>;
  };
}

/**
 * Memory readiness for the thread's next run, read-only:
 * - a root run with a live admission answers from that admission;
 * - otherwise the platform evaluates the admission's pure preconditions (the
 *   same function `run/start` begins with) for the request `run/start` would
 *   make, or, for a paused run whose admission is not open, for that run's
 *   committed snapshot.
 * It never queues behind a send, acquires a selection, discovers MCP tools or
 * warms a model.
 */
export async function readHostThreadMemory(
  platform: HostPlatform,
  params: HostParams<'thread/memory/read'>,
  context: HostMemoryReadContext
): Promise<MemoryRead> {
  if (!context.threads.has(params.threadId) || context.deletions.has(params.threadId)) {
    throw new Error('Unknown thread');
  }
  const root = context.children.rootThread(params.threadId);
  const active = [...context.runs.values()].find((run) => run.threadId === root && !run.terminal);
  if (active?.admission) {
    return {
      admission: { ready: true },
      observational: (await active.admission.readObservation?.(params.threadId)) ?? {
        state: 'off',
      },
    };
  }
  if (!platform.readMemoryReadiness) {
    throw new Error('This host has no memory readiness');
  }
  // Nothing to cancel: the preconditions acquire nothing.
  const { signal } = new AbortController();
  const request = active
    ? hostRunReopenRequest(active, signal)
    : {
        ...hostRunIntentRequest({ ...params, threadId: root }, context.origin, undefined, signal),
        ...context.workspaces.admissionBinding(root),
      };
  return await platform.readMemoryReadiness(request, params.threadId);
}
