import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import type { NativeIndexRuntime } from './native-index-runtime';

/** The activation's terminal fence, which this admission reads and may reopen. */
export interface ProfileAdmissionFence {
  readonly epoch: () => number;
  readonly reconfiguration: () => Promise<void> | undefined;
  readonly reopen: () => void;
  readonly requested: () => boolean;
}

/**
 * Agent host profile admission. BST-1945: a host's own Root release fences like
 * Main's retirement, but admission reopens once a failed start's host has fully
 * released. Main's own fences stay terminal; a lost ready host stays BST-1945's.
 */
export function createProfileAdmission<Attachment>(
  runtime: Pick<NativeIndexRuntime<Attachment>, 'acquireProfile' | 'retireFailedProfile'>,
  fence: ProfileAdmissionFence,
  closeRootCapabilities: () => Promise<void>
): { acquireProfile(): Promise<Attachment>; releaseRootForHost(): Promise<void> } {
  let hostReleasedEpoch: number | undefined;
  let reopening: Promise<boolean> | undefined;
  const reopenAfterFailedStart = (): Promise<boolean> => {
    reopening ??= (async () => {
      if (!(await runtime.retireFailedProfile())) {
        return false;
      }
      if (fence.requested() && hostReleasedEpoch !== fence.epoch()) {
        return false;
      }
      fence.reopen();
      return true;
    })().finally(() => {
      reopening = undefined;
    });
    return reopening;
  };
  const admit = async (): Promise<Attachment> => {
    try {
      return await runtime.acquireProfile({ indexIndependent: true });
    } catch (cause) {
      // Retry once after the failed host has exited and released its port; the
      // retry's launcher waits for its Root lock. Otherwise the failure stands.
      let reopened: boolean;
      try {
        reopened = await reopenAfterFailedStart();
      } catch (release) {
        throw cause instanceof AggregateError && cause.errors.includes(release)
          ? cause
          : new AggregateError([cause, release], 'Host acquisition failed and its release failed');
      }
      if (!reopened) {
        throw cause;
      }
      return runtime.acquireProfile({ indexIndependent: true });
    }
  };
  return {
    acquireProfile: async () => {
      if (fence.requested() && !(await reopenAfterFailedStart())) {
        throw new TransitionError('Profile admission is closed for terminal retirement.');
      }
      // Index setup errors remain on their own surface. The runtime separately
      // retains and rejects failed physical profile retirement before attachment.
      await fence.reconfiguration()?.catch(() => undefined);
      if (fence.requested()) {
        throw new TransitionError('Profile admission closed during index reconfiguration.');
      }
      const attachment = await admit();
      if (fence.requested()) {
        throw new TransitionError('Profile admission closed during attachment.');
      }
      return attachment;
    },
    releaseRootForHost: async () => {
      // A host that releases Root while Main's own retirement is already fenced (a start
      // failing during app shutdown) must not turn that terminal fence into a reopenable one.
      const underMainRetirement = fence.requested() && hostReleasedEpoch !== fence.epoch();
      const releasing = closeRootCapabilities();
      // closeRootCapabilities fences synchronously; record the epoch it opened.
      const epoch = fence.epoch();
      await releasing;
      if (!underMainRetirement) {
        hostReleasedEpoch = epoch;
      }
    },
  };
}
