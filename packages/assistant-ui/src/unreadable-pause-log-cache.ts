export const UNREADABLE_PAUSE_LOG_CAPACITY = 64;

const loggedUnreadablePauseKeys = new Set<string>();

export function rememberUnreadablePauseLogIdentity(pauseKey: string): boolean {
  if (loggedUnreadablePauseKeys.has(pauseKey)) {
    return false;
  }
  if (loggedUnreadablePauseKeys.size >= UNREADABLE_PAUSE_LOG_CAPACITY) {
    const oldestPauseKey = loggedUnreadablePauseKeys.values().next().value;
    if (oldestPauseKey !== undefined) {
      loggedUnreadablePauseKeys.delete(oldestPauseKey);
    }
  }
  loggedUnreadablePauseKeys.add(pauseKey);
  return true;
}

/** @internal Test-only reset for deterministic module-state assertions. */
export function __resetUnreadablePauseLogForTests(): void {
  loggedUnreadablePauseKeys.clear();
}
