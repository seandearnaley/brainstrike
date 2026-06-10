import { addLogListener, LogLevel, setLogLevel } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssistantForegroundActivityForTests,
  ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS,
  acquireAssistantForegroundActivity,
  getAssistantForegroundActivitySnapshot,
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
    const lease = acquireAssistantForegroundActivity({ onExpired });

    // Simulate a long-running stream: renew every 4 minutes for 40 minutes.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(4 * 60 * 1000);
      lease.renew();
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
    const lease = acquireAssistantForegroundActivity({ onExpired });

    vi.advanceTimersByTime(60 * 1000);
    lease.release();

    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS * 2);
    expect(warnCount()).toBe(0);
    expect(onExpired).not.toHaveBeenCalled();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });

  it('renew after release is a no-op and does not resurrect the lease', () => {
    const lease = acquireAssistantForegroundActivity();
    lease.release();

    lease.renew();
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);

    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS * 2);
    expect(warnCount()).toBe(0);
  });

  it('release is idempotent and only decrements once with overlapping leases', () => {
    const leaseA = acquireAssistantForegroundActivity();
    acquireAssistantForegroundActivity();

    leaseA.release();
    leaseA.release();
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);
  });

  it('renewing one lease does not keep a leaked sibling lease alive', () => {
    // The leak scenario the fuse exists for: run A's completion callback is
    // lost (lease leaked, never renewed), then run B starts and streams.
    // B's renewals must NOT reset A's timer — otherwise a leaked lease
    // survives as long as the assistant is in use at all, pausing background
    // indexing in every inter-run gap.
    const onExpiredA = vi.fn();
    const onExpiredB = vi.fn();
    acquireAssistantForegroundActivity({ onExpired: onExpiredA });

    vi.advanceTimersByTime(60 * 1000);
    const leaseB = acquireAssistantForegroundActivity({ onExpired: onExpiredB });

    // B streams: renew B every minute. A receives nothing.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(60 * 1000);
      leaseB.renew();
    }

    // A is now 5 minutes old with zero renewals: expired, despite B's activity.
    expect(onExpiredA).toHaveBeenCalledTimes(1);
    expect(onExpiredB).not.toHaveBeenCalled();
    // B is still live, so the QoS hint stays raised.
    expect(getAssistantForegroundActivitySnapshot()).toBe(true);

    // B keeps renewing past A's death without issue, then expires on ITS
    // own schedule once silent.
    vi.advanceTimersByTime(ASSISTANT_FOREGROUND_ACTIVITY_IDLE_FUSE_MS - 1);
    expect(onExpiredB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpiredB).toHaveBeenCalledTimes(1);
    expect(getAssistantForegroundActivitySnapshot()).toBe(false);
  });
});
