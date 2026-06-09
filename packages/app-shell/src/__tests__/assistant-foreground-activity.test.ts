import { addLogListener, LogLevel, setLogLevel } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
  acquireAssistantForegroundActivity,
  getAssistantForegroundActivitySnapshot,
  renewAssistantForegroundActivityLeases,
} from '../assistant-foreground-activity';

interface CapturedLog {
  readonly level: string;
  readonly message: string;
}

describe('assistant foreground activity idle fuse', () => {
  let logs: CapturedLog[];
  let removeLogListener: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    setLogLevel(LogLevel.WARN);
    logs = [];
    removeLogListener = addLogListener((entry) => {
      logs.push({ level: entry.level ?? '', message: entry.message ?? '' });
    });
  });

  afterEach(() => {
    removeLogListener();
    __resetAssistantForegroundActivityForTests();
    vi.useRealTimers();
  });

  const warnCount = (): number => logs.filter((entry) => entry.level === 'warn').length;

  it('expires a lease after 5 minutes of inactivity with a warning', () => {
    expect(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS).toBe(5 * 60 * 1000);

    const onExpired = vi.fn();
    acquireAssistantForegroundActivity({ onExpired });
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS - 1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(warnCount()).toBe(1);
    expect(logs.find((entry) => entry.level === 'warn')?.message).toContain('idle fuse expired');
  });

  it('renewal resets the idle timer so active runs stay alive indefinitely', () => {
    const onExpired = vi.fn();
    acquireAssistantForegroundActivity({ onExpired });

    // Simulate a long-running stream: renew every 4 minutes for 40 minutes.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(4 * 60 * 1000);
      renewAssistantForegroundActivityLeases();
    }
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);
    expect(onExpired).not.toHaveBeenCalled();
    expect(warnCount()).toBe(0);

    // Activity stops: fuse fires 5 minutes after the LAST renewal.
    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS - 1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('does not warn or expire when released before the fuse fires', () => {
    const onExpired = vi.fn();
    const release = acquireAssistantForegroundActivity({ onExpired });

    vi.advanceTimersByTime(60 * 1000);
    release();

    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS * 2);
    expect(warnCount()).toBe(0);
    expect(onExpired).not.toHaveBeenCalled();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('renew after release is a no-op and does not resurrect the lease', () => {
    const release = acquireAssistantForegroundActivity();
    release();

    renewAssistantForegroundActivityLeases();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);

    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS * 2);
    expect(warnCount()).toBe(0);
  });

  it('renew with no live leases does not throw', () => {
    expect(() => renewAssistantForegroundActivityLeases()).not.toThrow();
  });

  it('release is idempotent and only decrements once with overlapping leases', () => {
    const releaseA = acquireAssistantForegroundActivity();
    acquireAssistantForegroundActivity();

    releaseA();
    releaseA();
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);
  });

  it('renewal renews every live lease, not just the most recent', () => {
    const onExpiredA = vi.fn();
    const onExpiredB = vi.fn();
    acquireAssistantForegroundActivity({ onExpired: onExpiredA });

    vi.advanceTimersByTime(3 * 60 * 1000);
    acquireAssistantForegroundActivity({ onExpired: onExpiredB });

    vi.advanceTimersByTime(60 * 1000);
    renewAssistantForegroundActivityLeases();

    // Lease A is now 4 minutes old but freshly renewed — it must not expire
    // at its original 5-minute mark.
    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS - 1);
    expect(onExpiredA).not.toHaveBeenCalled();
    expect(onExpiredB).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onExpiredA).toHaveBeenCalledTimes(1);
    expect(onExpiredB).toHaveBeenCalledTimes(1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });
});
