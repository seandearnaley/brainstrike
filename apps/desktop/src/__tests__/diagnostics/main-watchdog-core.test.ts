import { describe, expect, it, vi } from 'vitest';

import {
  createMainWatchdogController,
  MAIN_WATCHDOG_CHECK_INTERVAL_MS,
  MAIN_WATCHDOG_FROZEN_THRESHOLD_MS,
} from '../../diagnostics/main-watchdog-core';

function createHarness() {
  let now = 0;
  let cpuUsage = { system: 400, user: 1000 };
  const appendFile = vi.fn();
  const writeStderr = vi.fn();
  const controller = createMainWatchdogController({
    appendFile,
    getCpuUsage: () => cpuUsage,
    getMemoryUsage: () => ({ heapUsed: 4096, rss: 10_240 }),
    now: () => now,
    writeStderr,
  });

  return {
    appendFile,
    controller,
    setCpuUsage(value: { system: number; user: number }) {
      cpuUsage = value;
    },
    setNow(value: number) {
      now = value;
    },
    writeStderr,
  };
}

describe('main watchdog controller', () => {
  it('ages heartbeats and only reports after the frozen threshold', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });

    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS);
    harness.setCpuUsage({ system: 425, user: 1050 });
    expect(harness.controller.check()).toBeNull();

    harness.controller.handleMessage({ type: 'heartbeat' });
    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 2);
    harness.setCpuUsage({ system: 450, user: 1100 });
    expect(harness.controller.check()).toBeNull();

    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 2 + 1);
    harness.setCpuUsage({ system: 470, user: 1130 });
    expect(harness.controller.check()).toMatchObject({
      cpuSystemDeltaMicros: 20,
      cpuUserDeltaMicros: 30,
      heartbeatAgeMs: MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1,
      msg: 'MAIN_THREAD_UNRESPONSIVE',
    });
    expect(harness.appendFile).toHaveBeenCalledOnce();
  });

  it('reports CPU deltas and writes the same record to stderr and the log', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    const diagnostic = harness.controller.check();

    expect(diagnostic).toMatchObject({
      cpuSystemDeltaMicros: 75,
      cpuUserDeltaMicros: 150,
      heapUsedKb: 4,
      rssKb: 10,
    });
    const serializedRecord = `${JSON.stringify(diagnostic)}\n`;
    expect(harness.writeStderr).toHaveBeenCalledWith(serializedRecord);
    expect(harness.appendFile).toHaveBeenCalledWith('/tmp/brainstrike-main.log', serializedRecord);
  });

  it('makes log append failures visible on stderr without stopping future checks', () => {
    const harness = createHarness();
    harness.appendFile.mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(() => harness.controller.check()).not.toThrow();
    const failureRecord = JSON.parse(harness.writeStderr.mock.calls[1]?.[0] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(failureRecord).toMatchObject({
      error: 'disk unavailable',
      level: 50,
      msg: 'MAIN_WATCHDOG_LOG_WRITE_FAILED',
      scope: 'MainWatchdog',
    });

    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + MAIN_WATCHDOG_CHECK_INTERVAL_MS + 1);
    harness.setCpuUsage({ system: 500, user: 1200 });
    expect(() => harness.controller.check()).not.toThrow();
    expect(harness.writeStderr).toHaveBeenCalledTimes(4);
  });

  it('uses stderr only when file logging is explicitly disabled', () => {
    const harness = createHarness();
    harness.controller.handleMessage({ logPath: null, type: 'config' });
    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(harness.controller.check()).toMatchObject({
      msg: 'MAIN_THREAD_UNRESPONSIVE',
    });
    expect(harness.writeStderr).toHaveBeenCalledOnce();
    expect(harness.appendFile).not.toHaveBeenCalled();
  });

  it('fails visibly when a frozen check occurs before configuration', () => {
    const harness = createHarness();
    harness.setNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(() => harness.controller.check()).toThrow(
      'Main watchdog has not received its log path configuration'
    );
  });
});
