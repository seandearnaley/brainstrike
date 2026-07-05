import { addLogListener } from '@brainstrike/utils';
import { describe, expect, it, vi } from 'vitest';
import { requestBrowserTursoPersistentStorage } from '../src/bootstrap/browser-storage-persistence.js';

interface CapturedLog {
  readonly level: string;
  readonly message: string;
}

async function withCapturedLogs<T>(
  work: () => Promise<T>
): Promise<{ logs: readonly CapturedLog[]; result: T }> {
  const logs: CapturedLog[] = [];
  const removeListener = addLogListener((entry) => {
    logs.push({ level: entry.level, message: entry.message ?? '' });
  });
  try {
    const result = await work();
    return { logs, result };
  } finally {
    removeListener();
  }
}

describe('requestBrowserTursoPersistentStorage', () => {
  it('reports and logs a granted persistent-storage upgrade', async () => {
    const persist = vi.fn(async () => true);
    const { logs, result } = await withCapturedLogs(() =>
      requestBrowserTursoPersistentStorage({ persist })
    );

    expect(result).toEqual({ granted: true, supported: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(logs.some((log) => log.level === 'info' && log.message.includes('granted: true'))).toBe(
      true
    );
  });

  it('reports and logs a denied request without throwing (best-effort eviction posture stays)', async () => {
    const persist = vi.fn(async () => false);
    const { logs, result } = await withCapturedLogs(() =>
      requestBrowserTursoPersistentStorage({ persist })
    );

    expect(result).toEqual({ granted: false, supported: true });
    expect(logs.some((log) => log.level === 'info' && log.message.includes('granted: false'))).toBe(
      true
    );
  });

  it('reports unsupported storage managers without throwing', async () => {
    const { logs, result } = await withCapturedLogs(() =>
      requestBrowserTursoPersistentStorage(undefined)
    );

    expect(result).toEqual({ granted: false, supported: false });
    expect(logs.some((log) => log.level === 'warn')).toBe(true);
  });

  it('logs a persist() rejection as an error and resolves instead of rejecting', async () => {
    const persist = vi.fn(async () => {
      throw new Error('permissions backend unavailable');
    });
    const { logs, result } = await withCapturedLogs(() =>
      requestBrowserTursoPersistentStorage({ persist })
    );

    expect(result).toEqual({ granted: false, supported: true });
    expect(logs.some((log) => log.level === 'error')).toBe(true);
  });
});
