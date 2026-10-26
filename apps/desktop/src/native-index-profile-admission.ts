import type { HostClient } from '@brainstrike/agent-host/client';
import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { HOST_LEASE_CLOSED } from './desktop-shutdown-state';
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
  profileRetired(): boolean;
  retireFailedProfile(): Promise<boolean>;
}

export interface NativeIndexProfileAdmission {
  /** Index work's borrow of the profile's host: started, joined, or refused. */
  acquire(signal?: AbortSignal): Promise<HostClient>;
  /**
   * A host client's borrow: a window, Main's own client, the catalogs. The host is the
   * profile's, not the index's, so the index's state never refuses it; readers see that state
   * as the index's status. Only a held Root, quit, a retired profile (until its resume) or the
   * host's own start failure refuses it.
   */
  acquireHost(signal?: AbortSignal): Promise<HostClient>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
}

/**
 * ADR-0031: a Root another process holds refuses this profile. The refusal stands until the app
 * starts again; no borrow starts another host against it.
 */
function heldRootRefusal(runtime: ProfileAdmissionRuntime): unknown {
  const failure = runtime.lastProfileFailure();
  return failure && heldRoot(failure.cause) ? failure.cause : undefined;
}

/**
 * A borrow that finds the index closed with no failed host left to retire. Released for a failed
 * start, the host is still releasing or another borrow is starting the next one, so the failed
 * start is this borrow's answer: the host was refused, not the index.
 */
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
  resumed: {
    /** Opens the idle index from its saved settings; never waited on. */
    readonly open: () => void;
    /** A host-loss resume that failed after a host client was admitted. */
    readonly failed: (error: unknown) => void;
  }
): NativeIndexProfileAdmission {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  // The idle generation this admission last resumed from a host release; it opens once a
  // host is admitted. A later resume is a new generation, so this never matches it.
  let resumedGeneration: number | undefined;
  /** BST-2004: resumes an index its lost or failed host's release closed. */
  const resumeReleased = async (owner: NativeIndexLifecycle): Promise<boolean> => {
    const state = await owner.state();
    if (state.kind === 'closed') {
      if (state.reason !== 'host-released') {
        return false;
      }
      const resuming = await owner.dispatch({ kind: 'profile-resume' });
      await owner.dispatch({ generation: resuming.generation, kind: 'profile-resumed' });
      resumedGeneration = resuming.generation;
    }
    return true;
  };
  /** BST-2004: joins a failed or lost host's Root release and resumes the index it closed. */
  const recover = async (owner: NativeIndexLifecycle): Promise<boolean> => {
    if (heldRootRefusal(runtime) !== undefined || !(await runtime.retireFailedProfile())) {
      return false;
    }
    return await resumeReleased(owner);
  };
  /** The index the lost host closed opens again once a replacement is admitted. */
  const openIfResumed = async (owner: NativeIndexLifecycle): Promise<void> => {
    const state = await owner.state();
    if (state.kind === 'idle' && state.generation === resumedGeneration) {
      resumed.open();
    }
  };
  const admitProfile = async (signal?: AbortSignal): Promise<HostClient> => {
    const owner = await lifecycle;
    const refused = heldRootRefusal(runtime);
    if (refused !== undefined) {
      throw refused;
    }
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    const recovered = await recover(owner);
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
      // The borrow does not wait for the open: host admission is index-independent.
      await openIfResumed(owner);
      return attachment;
    };
    try {
      return await admit();
    } catch (cause) {
      let recovered: boolean;
      try {
        recovered = await recover(owner);
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
  return {
    acquire: (signal) => {
      if (terminal) {
        return fenced.promise;
      }
      return Promise.race([admitProfile(signal), fenced.promise]);
    },
    acquireHost: async (signal) => {
      if (terminal) {
        return fenced.promise;
      }
      const refused = heldRootRefusal(runtime);
      if (refused !== undefined) {
        throw refused;
      }
      // A reset holds the Root through its deletion: no host starts against it until it resumes.
      if (runtime.profileRetired()) {
        throw new BoundaryFailureError(HOST_LEASE_CLOSED);
      }
      // The profile runtime joins a failed or lost host's release before it starts the next.
      const attachment = await Promise.race([
        runtime.acquireProfile({ indexIndependent: true }, signal),
        fenced.promise,
      ]);
      // Not waited on: the index's own state, not this borrow, shows how its resume goes.
      void (async () => {
        const owner = await lifecycle;
        if (await resumeReleased(owner)) {
          await openIfResumed(owner);
        }
      })().catch(resumed.failed);
      return attachment;
    },
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(nativeIndexClosedError('shutdown'));
      }
    },
  };
}
