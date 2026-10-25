import {
  nativeIndexClosedError,
  nativeIndexStateError as stateError,
} from './native-index-lifecycle-errors';
import type { NativeIndexLifecycle } from './native-index-lifecycle-owner';

interface ProfileAdmissionRuntime<Attachment> {
  acquireProfile(
    options: { readonly indexIndependent: true },
    signal?: AbortSignal
  ): Promise<Attachment>;
  retireFailedProfile(): Promise<boolean>;
}

export interface NativeIndexProfileAdmission<Attachment> {
  /** A borrow of the profile's host (a client's, or index work's): started, joined, or refused. */
  acquire(signal?: AbortSignal): Promise<Attachment>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
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
export function createNativeIndexProfileAdmission<Attachment>(
  lifecycle: Promise<NativeIndexLifecycle>,
  runtime: ProfileAdmissionRuntime<Attachment>,
  /** Opens the idle index from its saved settings; never waited on. */
  openResumed: () => void
): NativeIndexProfileAdmission<Attachment> {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  // The idle generation this admission last resumed from a host release; it opens once a
  // host is admitted. A later resume is a new generation, so this never matches it.
  let resumed: number | undefined;
  const admitProfile = async (signal?: AbortSignal): Promise<Attachment> => {
    const owner = await lifecycle;
    const recover = async (): Promise<boolean> => {
      if (!(await runtime.retireFailedProfile())) {
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
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    const recovered = await recover();
    let state = await owner.state();
    if (state.kind === 'closed' && !recovered) {
      throw stateError(state);
    }
    const admit = async (): Promise<Attachment> => {
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
  return {
    acquire: (signal) =>
      terminal ? fenced.promise : Promise.race([admitProfile(signal), fenced.promise]),
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(nativeIndexClosedError('shutdown'));
      }
    },
  };
}
