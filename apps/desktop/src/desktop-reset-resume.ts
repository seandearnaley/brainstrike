export interface DesktopResetResumePorts {
  /** Main's saved search index config, read and published to every window. */
  readonly publishIndexConfig: () => Promise<unknown>;
  /** Reopens the native index on the profile the reset left; rejects when it cannot. */
  readonly resumeIndex: (signal: AbortSignal) => Promise<void>;
  readonly resumeMcp: (outcome: 'failed' | 'succeeded') => Promise<void>;
}

/**
 * Main's reopen after a reset or content clear. A successful one leaves a profile that holds
 * its own config (a fresh one holds the default), so Main publishes it once the profile is
 * open: the replacement window loaded while the profile was closed, its one read was refused,
 * and it follows only what Main publishes. A failed reset kept the profile and its config.
 * A failed read rejects, so the reset reports it; MCP has already resumed.
 */
export function createDesktopResetResume(ports: DesktopResetResumePorts) {
  return async (outcome: 'failed' | 'succeeded', signal: AbortSignal): Promise<void> => {
    if (outcome === 'succeeded') {
      await ports.resumeIndex(signal);
    }
    signal.throwIfAborted();
    await ports.resumeMcp(outcome);
    if (outcome === 'succeeded') {
      await ports.publishIndexConfig();
    }
  };
}
