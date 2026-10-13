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
 * released. BST-2004: a ready host lost without Main asking reopens the same way.
 * Main's own fences stay terminal.
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
      // BST-2004: a ready host that exited unasked fails like a failed start. Its
      // retirement joins its Root release first, so admission reopens before the
      // next host starts instead of racing that release.
      const reopened = await reopenAfterFailedStart();
      if (fence.requested() && !reopened) {
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

/** Terminal reset cancellation uses the existing owner and joins its physical retirement. */
export async function resumeProfileForReset({
  fence,
  resume,
  retire,
  signal,
}: {
  readonly fence: ProfileAdmissionFence;
  readonly resume: () => Promise<void>;
  readonly retire: (reason?: unknown) => Promise<void>;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  signal?.throwIfAborted();
  let retirement: Promise<void> | undefined;
  const onAbort = (): void => {
    retirement = retire(signal?.reason);
    // The finally block owns the result, including a physical-close failure.
    retirement.catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const failures: unknown[] = [];
  try {
    const epoch = fence.epoch();
    await fence.reconfiguration()?.catch(() => undefined);
    signal?.throwIfAborted();
    if (fence.epoch() !== epoch) {
      throw new TransitionError('Native resume was superseded by terminal retirement.');
    }
    fence.reopen();
    await resume();
  } catch (error) {
    failures.push(error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await retirement;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Native reset resume and retirement failed');
  }
}
