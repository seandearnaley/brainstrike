import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract/boundary-failure';
import type { DesktopProfileRuntime } from '../desktop-profile-runtime';

export interface DesktopProfileAdmission<Attachment> {
  /** A borrow of the profile's host: started, joined, or refused. */
  acquire(signal?: AbortSignal): Promise<Attachment>;
  /** Quit begins: every borrow still waiting for the host's start-up is refused now. */
  fenceTerminal(): void;
}

/**
 * Profile admission for the host's clients (the catalog, Main's own client, visible clients).
 * It is the one place that decides to start another host: once, after the failed one's release
 * is joined, and only after a failure, which is the host's `failed` report or exit (lifecycle
 * R2: no clock fails a start).
 *
 * BST-2247: a borrow never waits out a start-up that quit has fenced. Quit's fence refuses every
 * borrow still waiting, as the shutdown begins. The start-up itself stays its profile owner's,
 * which cancels it when the profile retires; a refused borrower only stops waiting for it.
 */
export function createDesktopProfileAdmission<Attachment>(
  profile: Pick<DesktopProfileRuntime<Attachment>, 'acquire' | 'retireFailed'>
): DesktopProfileAdmission<Attachment> {
  const fenced = Promise.withResolvers<never>();
  fenced.promise.catch(() => undefined);
  let terminal = false;
  const admit = async (signal?: AbortSignal): Promise<Attachment> => {
    // BST-2004: a lost ready host fails like a failed start; join its release first.
    await profile.retireFailed();
    try {
      return await profile.acquire(signal);
    } catch (cause) {
      let recovered: boolean;
      try {
        recovered = await profile.retireFailed();
      } catch (release) {
        throw new AggregateError(
          [cause, release],
          'Host acquisition failed and its release failed'
        );
      }
      if (!recovered) {
        throw cause;
      }
      return await profile.acquire(signal);
    }
  };
  return {
    acquire: (signal) =>
      terminal ? fenced.promise : Promise.race([admit(signal), fenced.promise]),
    fenceTerminal: () => {
      if (!terminal) {
        terminal = true;
        fenced.reject(
          new BoundaryFailureError(
            refusal({
              category: 'availability',
              code: 'host.closing',
              message: 'The desktop is closing its agent host.',
            })
          )
        );
      }
    },
  };
}
