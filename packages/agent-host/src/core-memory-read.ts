import type { HostChildRuns } from './core-child-runs.js';
import type { HostRunState } from './core-state.js';
import type {
  HostClientOrigin,
  HostPlatform,
  HostRunAdmission,
  HostRunAdmissionRequest,
} from './ports.js';
import type { HostParams, HostResults } from './protocol.js';
import {
  acquireHostRunAdmission,
  HostRunAdmissionCleanupError,
  hostRunCommandRequest,
} from './run-admission.js';

type MemoryRead = HostResults['thread/memory/read'];

/** Core's state one read uses, inside Core's command admission queue. */
export interface HostMemoryReadContext {
  readonly children: Pick<HostChildRuns, 'rootThread'>;
  readonly origin: HostClientOrigin | undefined;
  /** Registered while the admission is pending, so thread deletion and close abort it. */
  readonly pendingAdmissions: Map<AbortController, string>;
  readonly runs: ReadonlyMap<string, Pick<HostRunState, 'admission' | 'terminal' | 'threadId'>>;
  readonly workspaces: {
    admissionBinding(threadId: string): Pick<HostRunAdmissionRequest, 'workspaceBinding'>;
  };
}

async function observation(admission: HostRunAdmission, threadId: string): Promise<MemoryRead> {
  return {
    admission: { ready: true },
    observational: (await admission.readObservation?.(threadId)) ?? { state: 'off' },
  };
}

/**
 * Memory readiness for the thread's next run: the admission `run/start`
 * makes (for the root, without a prompt), released at once. The platform holds
 * one selection per thread, so a thread with an active run answers from that
 * run's own admission. The failure of a new admission is the reason; nothing
 * is committed.
 */
export async function readHostThreadMemory(
  platform: HostPlatform,
  params: HostParams<'thread/memory/read'>,
  context: HostMemoryReadContext
): Promise<MemoryRead> {
  const root = context.children.rootThread(params.threadId);
  const active = [...context.runs.values()].find((run) => run.threadId === root && !run.terminal);
  if (active) {
    if (!active.admission) {
      throw new Error("The thread's active run has not reopened its admission");
    }
    return await observation(active.admission, params.threadId);
  }
  const controller = new AbortController();
  context.pendingAdmissions.set(controller, params.threadId);
  try {
    let admission: HostRunAdmission;
    try {
      admission = await acquireHostRunAdmission(platform, {
        ...hostRunCommandRequest(
          { ...params, threadId: root },
          context.origin,
          undefined,
          controller.signal
        ),
        ...context.workspaces.admissionBinding(root),
      });
    } catch (cause) {
      // A leaked selection or a retired thread is not a readiness answer.
      if (cause instanceof HostRunAdmissionCleanupError || controller.signal.aborted) {
        throw cause;
      }
      return {
        admission: { ready: false, reason: cause instanceof Error ? cause.message : String(cause) },
      };
    }
    try {
      return await observation(admission, params.threadId);
    } finally {
      await admission.close?.();
    }
  } finally {
    context.pendingAdmissions.delete(controller);
  }
}
