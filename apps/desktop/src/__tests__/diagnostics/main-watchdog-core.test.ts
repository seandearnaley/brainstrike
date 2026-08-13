import { describe, expect, it, vi } from 'vitest';

import {
  createMainWatchdogController,
  MAIN_WATCHDOG_CHECK_INTERVAL_MS,
  MAIN_WATCHDOG_FROZEN_THRESHOLD_MS,
} from '../../diagnostics/main-watchdog-core';

function createHarness() {
  let elapsedNow = 0;
  let wallNow = Date.UTC(2026, 0, 1);
  let cpuUsage = { system: 400, user: 1000 };
  const appendFile = vi.fn();
  const writeStderr = vi.fn();
  const controller = createMainWatchdogController({
    appendFile,
    elapsedNow: () => elapsedNow,
    getCpuUsage: () => cpuUsage,
    getMemoryUsage: () => ({ heapUsed: 4096, rss: 10_240 }),
    wallNow: () => wallNow,
    writeStderr,
  });

  return {
    appendFile,
    controller,
    setCpuUsage(value: { system: number; user: number }) {
      cpuUsage = value;
    },
    setElapsedNow(value: number) {
      elapsedNow = value;
    },
    setWallNow(value: number) {
      wallNow = value;
    },
    writeStderr,
  };
}

function runHealthyChecksUntilThreshold(harness: ReturnType<typeof createHarness>): void {
  for (
    let elapsed = MAIN_WATCHDOG_CHECK_INTERVAL_MS;
    elapsed <= MAIN_WATCHDOG_FROZEN_THRESHOLD_MS;
    elapsed += MAIN_WATCHDOG_CHECK_INTERVAL_MS
  ) {
    harness.setElapsedNow(elapsed);
    expect(harness.controller.check()).toBeNull();
  }
}

describe('main watchdog controller', () => {
  it('ages heartbeats and only reports after the frozen threshold', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS);
    harness.setCpuUsage({ system: 425, user: 1050 });
    expect(harness.controller.check()).toBeNull();

    harness.controller.handleMessage({ type: 'heartbeat' });
    for (
      let elapsed = MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + MAIN_WATCHDOG_CHECK_INTERVAL_MS;
      elapsed <= MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 2;
      elapsed += MAIN_WATCHDOG_CHECK_INTERVAL_MS
    ) {
      harness.setElapsedNow(elapsed);
      harness.setCpuUsage({ system: 450, user: 1100 });
      expect(harness.controller.check()).toBeNull();
    }

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 2 + 1);
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
    runHealthyChecksUntilThreshold(harness);
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
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
    runHealthyChecksUntilThreshold(harness);
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
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

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + MAIN_WATCHDOG_CHECK_INTERVAL_MS + 1);
    harness.setCpuUsage({ system: 500, user: 1200 });
    expect(() => harness.controller.check()).not.toThrow();
    expect(harness.writeStderr).toHaveBeenCalledTimes(4);
  });

  it('uses stderr only when file logging is explicitly disabled', () => {
    const harness = createHarness();
    harness.controller.handleMessage({ logPath: null, type: 'config' });
    runHealthyChecksUntilThreshold(harness);
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(harness.controller.check()).toMatchObject({
      msg: 'MAIN_THREAD_UNRESPONSIVE',
    });
    expect(harness.writeStderr).toHaveBeenCalledOnce();
    expect(harness.appendFile).not.toHaveBeenCalled();
  });

  it('fails visibly when a frozen check occurs before configuration', () => {
    const harness = createHarness();
    runHealthyChecksUntilThreshold(harness);
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(() => harness.controller.check()).toThrow(
      'Main watchdog has not received its log path configuration'
    );
  });

  it('uses monotonic elapsed time for aging when the wall clock moves backward', () => {
    const harness = createHarness();
    const movedBackwardWallTime = Date.UTC(2025, 11, 31, 23, 59, 0);
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    runHealthyChecksUntilThreshold(harness);
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setWallNow(movedBackwardWallTime);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(harness.controller.check()).toMatchObject({
      heartbeatAgeMs: MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1,
      time: new Date(movedBackwardWallTime).toISOString(),
    });
  });

  it('resets its observation baselines after its own scheduling discontinuity', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(harness.controller.check()).toBeNull();
    expect(harness.writeStderr).not.toHaveBeenCalled();

    for (let check = 1; check <= 4; check += 1) {
      harness.setElapsedNow(
        MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1 + MAIN_WATCHDOG_CHECK_INTERVAL_MS * check
      );
      harness.setCpuUsage({ system: 475 + check * 5, user: 1150 + check * 10 });
      expect(harness.controller.check()).toBeNull();
    }

    harness.setElapsedNow(
      MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 2 + MAIN_WATCHDOG_CHECK_INTERVAL_MS * 4
    );
    harness.setCpuUsage({ system: 500, user: 1200 });
    expect(harness.controller.check()).toMatchObject({
      cpuSystemDeltaMicros: 5,
      cpuUserDeltaMicros: 10,
      heartbeatAgeMs: MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1,
    });
  });

  it('treats a phase-offset delayed check as an observation discontinuity', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    harness.setElapsedNow(1000);
    harness.controller.handleMessage({ type: 'heartbeat' });
    harness.setElapsedNow(MAIN_WATCHDOG_CHECK_INTERVAL_MS);
    harness.setCpuUsage({ system: 425, user: 1050 });
    expect(harness.controller.check()).toBeNull();

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1500);
    harness.setCpuUsage({ system: 475, user: 1150 });
    expect(harness.controller.check()).toBeNull();
    expect(harness.writeStderr).not.toHaveBeenCalled();
  });

  it('resets an unconfigured discontinuity before enforcing a full observable window', () => {
    const harness = createHarness();
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1);
    harness.setCpuUsage({ system: 475, user: 1150 });

    expect(harness.controller.check()).toBeNull();
    expect(harness.writeStderr).not.toHaveBeenCalled();

    runHealthyChecksUntilThreshold({
      ...harness,
      setElapsedNow(value: number) {
        harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1 + value);
      },
    });
    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 2 + 2);
    expect(() => harness.controller.check()).toThrow(
      'Main watchdog has not received its log path configuration'
    );
  });

  it('pauses on suspend and resets heartbeat and CPU baselines on resume', () => {
    const harness = createHarness();
    harness.controller.handleMessage({
      logPath: '/tmp/brainstrike-main.log',
      type: 'config',
    });
    harness.setElapsedNow(MAIN_WATCHDOG_CHECK_INTERVAL_MS);
    harness.setCpuUsage({ system: 425, user: 1050 });
    harness.controller.handleMessage({ type: 'suspend' });

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3);
    harness.setCpuUsage({ system: 1000, user: 2000 });
    expect(harness.controller.check()).toBeNull();

    harness.controller.handleMessage({ type: 'resume' });
    for (
      let elapsed = MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3 + MAIN_WATCHDOG_CHECK_INTERVAL_MS;
      elapsed <= MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 4;
      elapsed += MAIN_WATCHDOG_CHECK_INTERVAL_MS
    ) {
      harness.setElapsedNow(elapsed);
      harness.setCpuUsage({ system: 1020, user: 2030 });
      expect(harness.controller.check()).toBeNull();
    }

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 4 + 1);
    harness.setCpuUsage({ system: 1025, user: 2040 });
    expect(harness.controller.check()).toMatchObject({
      cpuSystemDeltaMicros: 5,
      cpuUserDeltaMicros: 10,
      heartbeatAgeMs: MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1,
    });
  });

  it('self-recovers when the main thread never delivers resume after wake', () => {
    const harness = createHarness();
    harness.controller.handleMessage({ logPath: null, type: 'config' });
    harness.controller.handleMessage({ type: 'suspend' });

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3);
    harness.setCpuUsage({ system: 1000, user: 2000 });
    expect(harness.controller.check()).toBeNull();

    harness.setElapsedNow(MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3 + MAIN_WATCHDOG_CHECK_INTERVAL_MS);
    harness.setCpuUsage({ system: 1020, user: 2030 });
    expect(harness.controller.check()).toBeNull();
    harness.setElapsedNow(
      MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3 + MAIN_WATCHDOG_CHECK_INTERVAL_MS * 2
    );
    harness.setCpuUsage({ system: 1040, user: 2060 });
    expect(harness.controller.check()).toBeNull();

    for (let check = 3; check <= 6; check += 1) {
      harness.setElapsedNow(
        MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3 + MAIN_WATCHDOG_CHECK_INTERVAL_MS * check
      );
      harness.setCpuUsage({ system: 1040 + check * 5, user: 2060 + check * 10 });
      expect(harness.controller.check()).toBeNull();
    }

    harness.setElapsedNow(
      MAIN_WATCHDOG_FROZEN_THRESHOLD_MS * 3 + MAIN_WATCHDOG_CHECK_INTERVAL_MS * 6 + 1
    );
    harness.setCpuUsage({ system: 1075, user: 2130 });
    expect(harness.controller.check()).toMatchObject({
      heartbeatAgeMs: MAIN_WATCHDOG_FROZEN_THRESHOLD_MS + 1,
      msg: 'MAIN_THREAD_UNRESPONSIVE',
    });
  });
});
