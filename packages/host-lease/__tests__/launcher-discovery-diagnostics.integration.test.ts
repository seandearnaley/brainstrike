import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { LiveHostUnavailableError, launchHost } from '../src/launcher.js';
import * as records from '../src/record-file.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

test.each([false, true])(
  'initial discovery expiry retains the original error and bounded observation (enabled=%s)',
  async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-discovery-proof-'));
    await records.secureDirectory(root);
    const lock = await RootLock.acquire(root);
    const captured: string[] = [];
    vi.stubEnv('BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE', enabled ? '1' : undefined);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    const began = Date.UTC(2026, 9, 20);
    const budget = 1000;
    vi.useFakeTimers({ now: began, toFake: ['Date'] });
    const originalRead = records.readHostRecord;
    const read = vi.spyOn(records, 'readHostRecord').mockImplementationOnce(async (path) => {
      const record = await originalRead(path);
      // Consume the existing budget during the actual initial record read.
      // Timers, lease verification and filesystem operations remain real.
      vi.setSystemTime(began + budget + 1);
      return record;
    });
    const spawn = vi.fn(async () => {
      throw new Error('Discovery expiry must not start a host');
    });
    try {
      const error = await launchHost(root, {
        lifetime: 'cli',
        spawn,
        startupTimeoutMs: budget,
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(LiveHostUnavailableError);
      expect(error).toMatchObject({
        cause: { message: 'Host record publication timed out' },
        pid: process.pid,
      });
      expect(read).toHaveBeenCalledOnce();
      expect(spawn).not.toHaveBeenCalled();
      const events = captured
        .filter((line) => line.startsWith('[host-attach-proof] '))
        .map((line) => JSON.parse(line.slice('[host-attach-proof] '.length)));
      if (!enabled) {
        expect(events).toEqual([]);
        return;
      }
      expect(events.map((event) => event.phase)).toEqual([
        'monitor-start',
        'record-discovery-owner',
        'record-discovery-timeout',
        'record-discovery-settled',
      ]);
      expect(new Set(events.map((event) => event.attemptId)).size).toBe(1);
      expect(events[2]).toMatchObject({
        budget: 'existing-owner',
        elapsedMs: expect.any(Number),
        hostPid: process.pid,
        lastStage: 'existingRecord-after',
        remainingMs: -1,
        scope: 'record-discovery',
        stageElapsedMs: expect.any(Number),
        timeoutMs: budget,
      });
      expect(events[3]).toMatchObject({ lastStage: 'existingRecord-after', remainingMs: -1 });
      expect(captured.join('')).not.toContain(root);
      expect(events.some((event) => event.scope === 'record-publication')).toBe(false);
    } finally {
      lock.release();
      await rm(root, { force: true, recursive: true });
    }
  }
);
