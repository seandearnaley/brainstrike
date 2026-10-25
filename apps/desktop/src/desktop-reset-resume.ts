export interface DesktopResetResumePorts {
  readonly resumeMcp: (outcome: 'failed' | 'succeeded') => Promise<void>;
  /** Reopens the profile the reset left: its host starts, and its index opens with it. */
  readonly resumeProfile: (signal: AbortSignal) => Promise<void>;
}

/**
 * Main's reopen after a reset or content clear. A successful one leaves a profile that holds
 * its own config (a fresh one holds the default); its host publishes the index's to every
 * subscribed window once it opens. A failed reset kept the profile and its config.
 */
export function createDesktopResetResume(ports: DesktopResetResumePorts) {
  return async (outcome: 'failed' | 'succeeded', signal: AbortSignal): Promise<void> => {
    if (outcome === 'succeeded') {
      await ports.resumeProfile(signal);
    }
    signal.throwIfAborted();
    await ports.resumeMcp(outcome);
  };
}
