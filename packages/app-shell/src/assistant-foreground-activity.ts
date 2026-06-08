import { createLogger } from '@brainstrike/utils/logger';

export const ASSISTANT_FOREGROUND_ACTIVITY_LEASE_MS = 120_000;

const logger = createLogger('AssistantForegroundActivity');
const activeLeaseTimers = new Set<ReturnType<typeof setTimeout>>();
let activeCount = 0;

export function getAssistantForegroundActivitySnapshot(): boolean {
  return activeCount > 0;
}

export function acquireAssistantForegroundActivity(): () => void {
  let released = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    activeCount = Math.max(0, activeCount - 1);
    if (timeout) {
      clearTimeout(timeout);
      activeLeaseTimers.delete(timeout);
      timeout = null;
    }
  };

  activeCount += 1;
  timeout = setTimeout(() => {
    logger.warn(
      'Assistant foreground activity lease expired; releasing Workspace Index QoS hint.',
      {
        leaseMs: ASSISTANT_FOREGROUND_ACTIVITY_LEASE_MS,
      }
    );
    release();
  }, ASSISTANT_FOREGROUND_ACTIVITY_LEASE_MS);
  activeLeaseTimers.add(timeout);

  return release;
}

export function __resetAssistantForegroundActivityForTests(): void {
  for (const timeout of activeLeaseTimers) {
    clearTimeout(timeout);
  }
  activeLeaseTimers.clear();
  activeCount = 0;
}
