import type { HostClient } from '@brainstrike/agent-host/client';
import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { heldRoot } from './native-index-boundary-failure';
import type { NativeIndexState } from './native-index-lifecycle';
import {
  nativeIndexClosedError,
  nativeIndexStateError as stateError,
} from './native-index-lifecycle-errors';
import type { NativeIndexLifecycle } from './native-index-lifecycle-owner';

interface ProfileAdmissionRuntime {
  acquireProfile(
    options: { readonly indexIndependent: true },
    signal?: AbortSignal
  ): Promise<HostClient>;
  lastProfileFailure(): { readonly cause: unknown } | undefined;
  retireFailedProfile(): Promise<boolean>;
}

export interface NativeIndexProfileAdmission {
  /** A borrow of the profile's host (a client's, or index work's): started, joined, or refused. */
  acquire(signal?: AbortSignal): Promise<HostClient>;
  /**
   * A window's client borrow, which never runs inside index work. When it finds the host
   * released while other borrows start its replacement, it admits again once they settle
   * instead of being refused.
   */
  acquireClient(signal?: AbortSignal): Promise<HostClient>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
}

/**
 * A borrow that finds the index closed with no failed host left to retire. Released for a failed
 * start, the host is still releasing or another borrow is starting the next one, so the failed
 * start is this borrow's answer: the host was refused, not the index.
 */
/**
 * ADR-0031: a Root another process holds refuses this profile. The refusal stands until the app
 * starts again; no borrow starts another host against it.
 */
function heldRootRefusal(runtime: ProfileAdmissionRuntime): unknown {
  const failure = runtime.lastProfileFailure();
  return failure && heldRoot(failure.cause) ? failure.cause : undefined;
}

/** The refusal a borrow gets when it finds the host released and nothing left to retire. */
function isReleasedHostRefusal(cause: unknown): boolean {
  return (
    cause instanceof NativeIndexRefusalError &&
    cause.refusal.kind === 'closed' &&
    cause.refusal.reason === 'host-released'
  );
}

function closedRefusal(
  state: Extract<NativeIndexState, { readonly kind: 'closed' }>,
  runtime: ProfileAdmissionRuntime
): unknown {
  const failure = state.reason === 'host-released' ? runtime.lastProfileFailure() : undefined;
  return failure ? failure.cause : stateError(state);
}

/**
 * Profile admission for the host's clients (catalog, Main's own client, visible clients) and
 * for index work. It is the one place that decides to start another host: once, after the
 * failed one's release is joined, and only after a failure, which is the host's `failed`
 * report or exit (lifecycle R2: no clock fails a start).
 *
 * BST-2247: a borrow never waits out a start-up that quit has fenced. Quit's fence refuses
 * every borrow still waiting, with the terminal refusal, as the shutdown begins. The start-up
 * itself stays its profile owner's, which cancels it when the profile retires in the
 * native-index shutdown step; a refused borrower only stops waiting for it.
 */
export function createNativeIndexProfileAdmission(
  lifecycle: Promise<NativeIndexLifecycle>,
  runtime: ProfileAdmissionRuntime,
  /** Opens the idle index from its saved settings; never waited on. */
  openResumed: () => void
): NativeIndexProfileAdmission {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  // The idle generation this admission last resumed from a host release; it opens once a
  // host is admitted. A later resume is a new generation, so this never matches it.
  let resumed: number | undefined;
  const admitProfile = async (signal?: AbortSignal): Promise<HostClient> => {
    const owner = await lifecycle;
    const recover = async (): Promise<boolean> => {
      if (heldRootRefusal(runtime) !== undefined || !(await runtime.retireFailedProfile())) {
        return false;
      }
      const state = await owner.state();
      if (state.kind === 'closed') {
        if (state.reason !== 'host-released') {
          return false;
        }
        const resuming = await owner.dispatch({ kind: 'profile-resume' });
        await owner.dispatch({ generation: resuming.generation, kind: 'profile-resumed' });
        resumed = resuming.generation;
      }
      return true;
    };
    const refused = heldRootRefusal(runtime);
    if (refused !== undefined) {
      throw refused;
    }
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    const recovered = await recover();
    let state = await owner.state();
    if (state.kind === 'closed' && !recovered) {
      throw closedRefusal(state, runtime);
    }
    const admit = async (): Promise<HostClient> => {
      const attachment = await runtime.acquireProfile({ indexIndependent: true }, signal);
      state = await owner.state();
      if (state.kind === 'closed') {
        throw stateError(state);
      }
      if (state.kind === 'idle' && state.generation === resumed) {
        // BST-2004: the index the lost host closed opens again once a replacement is
        // admitted. The borrow does not wait for it: host admission is index-independent.
        openResumed();
      }
      return attachment;
    };
    try {
      return await admit();
    } catch (cause) {
      let recovered: boolean;
      try {
        recovered = await recover();
      } catch (release) {
        throw cause instanceof AggregateError && cause.errors.includes(release)
          ? cause
          : new AggregateError([cause, release], 'Host acquisition failed and its release failed');
      }
      if (!recovered) {
        throw cause;
      }
      return admit();
    }
  };
  const admitting = new Set<Promise<HostClient>>();
  const acquire = (signal?: AbortSignal): Promise<HostClient> => {
    if (terminal) {
      return fenced.promise;
    }
    const admission = admitProfile(signal);
    admitting.add(admission);
    const settled = (): void => {
      admitting.delete(admission);
    };
    admission.then(settled, settled);
    return Promise.race([admission, fenced.promise]);
  };
  return {
    acquire,
    acquireClient: async (signal) => {
      try {
        return await acquire(signal);
      } catch (cause) {
        // BST-2004: another borrow is retiring the lost host and starting the next one. Index work
        // never waits on it (it may hold the index queue that recovery needs); a window can.
        if (!(isReleasedHostRefusal(cause) && admitting.size > 0)) {
          throw cause;
        }
        await Promise.allSettled([...admitting]);
        return acquire(signal);
      }
    },
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(nativeIndexClosedError('shutdown'));
      }
    },
  };
}
