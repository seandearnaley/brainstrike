export interface DesktopResetResumePorts {
  readonly resumeMcp: (outcome: 'failed' | 'succeeded') => Promise<void>;
  /** Reopens the host profile the reset left; rejects when it cannot. */
  readonly resumeProfile: (signal: AbortSignal) => Promise<void>;
}

/**
 * Main's reopen after a reset or content clear. A successful one reopens the profile it left
 * before MCP resumes; a failed reset kept the profile, so only MCP resumes.
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
