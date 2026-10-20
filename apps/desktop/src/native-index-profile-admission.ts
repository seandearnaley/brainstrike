import type { HostAttachment } from '@brainstrike/host-lease';
import {
  nativeIndexClosedError,
  nativeIndexStateError as stateError,
} from './native-index-lifecycle-errors';
import type { NativeIndexLifecycle } from './native-index-lifecycle-owner';

interface ProfileAdmissionRuntime {
  acquireProfile(options: { readonly indexIndependent: true }): Promise<HostAttachment>;
  retireFailedProfile(): Promise<boolean>;
}

export interface NativeIndexProfileAdmission {
  /** A client's borrow of the profile's host: started, joined, or refused. */
  acquire(): Promise<HostAttachment>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
}

/**
 * Profile admission for the host's clients (catalog, Main's own client, visible clients).
 *
 * BST-2247: a borrow never waits out a start-up that quit has fenced. Quit's fence refuses
 * every borrow still waiting, with the terminal refusal, as the shutdown begins. The start-up
 * itself stays its profile owner's, which cancels it when the profile retires in the
 * native-index shutdown step; a refused borrower only stops waiting for it.
 */
export function createNativeIndexProfileAdmission(
  lifecycle: Promise<NativeIndexLifecycle>,
  runtime: ProfileAdmissionRuntime
): NativeIndexProfileAdmission {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  const admitProfile = async (): Promise<HostAttachment> => {
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
      }
      return true;
    };
    // BST-2004: a lost ready host fails like a failed start; join its Root release first.
    const recovered = await recover();
    let state = await owner.state();
    if (state.kind === 'closed' && !recovered) {
      throw stateError(state);
    }
    const admit = async (): Promise<HostAttachment> => {
      const attachment = await runtime.acquireProfile({ indexIndependent: true });
      state = await owner.state();
      if (state.kind === 'closed') {
        throw stateError(state);
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
    acquire: () => (terminal ? fenced.promise : Promise.race([admitProfile(), fenced.promise])),
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(nativeIndexClosedError('shutdown'));
      }
    },
  };
}
