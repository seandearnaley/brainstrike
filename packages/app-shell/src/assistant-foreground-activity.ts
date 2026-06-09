import { createLogger } from '@brainstrike/utils/logger';

/**
 * Idle leak fuse for assistant foreground activity leases.
 *
 * A lease marks "assistant work in flight" so Workspace Index QoS yields to
 * the user. Legitimate runs produce stream/tool activity, which renews the
 * lease via renewAssistantForegroundActivityLeases(); only a *leaked* lease
 * (lost completion callback) goes silent, so it auto-releases after 5 minutes
 * of inactivity instead of pausing indexing indefinitely.
 */
export const ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS = 5 * 60 * 1000;

export interface AssistantForegroundActivityOptions {
  readonly onExpired?: () => void;
}

interface ActiveLease {
  readonly options: AssistantForegroundActivityOptions;
  timeout: ReturnType<typeof setTimeout> | null;
}

const logger = createLogger('AssistantForegroundActivity');
const activeLeases = new Set<ActiveLease>();

export function getAssistantForegroundActivitySnapshot(): boolean {
  return activeLeases.size > 0;
}

function scheduleIdleFuse(lease: ActiveLease): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    logger.warn(
      'Assistant foreground activity idle fuse expired; releasing Workspace Index QoS hint.',
      {
        idleFuseMs: ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
      }
    );
    activeLeases.delete(lease);
    lease.options.onExpired?.();
  }, ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS);
}

export function acquireAssistantForegroundActivity(
  options: AssistantForegroundActivityOptions = {}
): () => void {
  const lease: ActiveLease = { options, timeout: null };
  lease.timeout = scheduleIdleFuse(lease);
  activeLeases.add(lease);

  return () => {
    if (!activeLeases.has(lease)) {
      return;
    }
    activeLeases.delete(lease);
    if (lease.timeout) {
      clearTimeout(lease.timeout);
      lease.timeout = null;
    }
  };
}

/**
 * Renew the idle fuse on every live lease. Called from the assistant
 * streaming path on each chunk/tool event — "the assistant produced output"
 * is the proof of life that keeps leases from being treated as leaked.
 */
export function renewAssistantForegroundActivityLeases(): void {
  for (const lease of activeLeases) {
    if (lease.timeout) {
      clearTimeout(lease.timeout);
    }
    lease.timeout = scheduleIdleFuse(lease);
  }
}

export function __resetAssistantForegroundActivityForTests(): void {
  for (const lease of activeLeases) {
    if (lease.timeout) {
      clearTimeout(lease.timeout);
    }
  }
  activeLeases.clear();
}
