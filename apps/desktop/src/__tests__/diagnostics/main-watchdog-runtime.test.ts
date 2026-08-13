import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createMainWatchdogRuntime } from '../../diagnostics/main-watchdog-runtime';

const ENABLED_CUSTOM_LOGGING = {
  destination: '/custom/brainstrike.log',
  enabled: true,
} as const;

describe('main watchdog runtime', () => {
  it('sends the initial log destination and every successful live reconfiguration', () => {
    const postMessage = vi.fn();
    const runtime = createMainWatchdogRuntime();

    expect(() =>
      runtime.configureLogging({ destination: '/before-attach.log', enabled: true })
    ).toThrow('Main watchdog runtime is not attached');

    runtime.attach(postMessage, ENABLED_CUSTOM_LOGGING);
    runtime.configureLogging({ destination: '/retained-but-disabled.log', enabled: false });
    runtime.configureLogging({ destination: '/custom/updated.log', enabled: true });

    expect(postMessage.mock.calls).toEqual([
      [{ logPath: '/custom/brainstrike.log', type: 'config' }],
      [{ logPath: null, type: 'config' }],
      [{ logPath: '/custom/updated.log', type: 'config' }],
    ]);
  });

  it('rejects enabled file logging without a destination instead of inventing one', () => {
    const postMessage = vi.fn();
    const runtime = createMainWatchdogRuntime();

    expect(() => runtime.attach(postMessage, { destination: null, enabled: true })).toThrow(
      'Main watchdog file logging is enabled without a destination'
    );
    expect(postMessage).not.toHaveBeenCalled();

    runtime.attach(postMessage, ENABLED_CUSTOM_LOGGING);
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it('preserves heartbeat and OS suspend/resume message ordering', () => {
    const postMessage = vi.fn();
    const runtime = createMainWatchdogRuntime();
    runtime.attach(postMessage, ENABLED_CUSTOM_LOGGING);
    postMessage.mockClear();

    runtime.heartbeat();
    runtime.suspend();
    runtime.resume();
    runtime.heartbeat();

    expect(postMessage.mock.calls).toEqual([
      [{ type: 'heartbeat' }],
      [{ type: 'suspend' }],
      [{ type: 'resume' }],
      [{ type: 'heartbeat' }],
    ]);
  });

  it('makes use after worker exit visible', () => {
    const runtime = createMainWatchdogRuntime();
    runtime.attach(vi.fn(), ENABLED_CUSTOM_LOGGING);
    runtime.detach();

    expect(() => runtime.heartbeat()).toThrow('Main watchdog runtime is not attached');
    expect(() => runtime.configureLogging(ENABLED_CUSTOM_LOGGING)).toThrow(
      'Main watchdog runtime is not attached'
    );
  });
});

describe('main watchdog source wiring', () => {
  const mainSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

  function readPowerHandler(event: string, nextEvent: string): string {
    const start = mainSource.indexOf(`powerMonitor.on('${event}'`);
    const end = mainSource.indexOf(`powerMonitor.on('${nextEvent}'`, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return mainSource.slice(start, end);
  }

  it('attaches with current logging and applies successful runtime preference changes', () => {
    expect(mainSource).toContain('mainWatchdogRuntime.attach(');
    expect(mainSource).toContain('currentLoggingPreferences.file');
    expect(mainSource).toContain('mainWatchdogRuntime.configureLogging(normalized.file)');
    expect(mainSource.indexOf('mainWatchdogRuntime.attach(')).toBeLessThan(
      mainSource.indexOf('const mainWindow = await createMainWindow()')
    );
  });

  it('notifies the watchdog before OS suspend/resume work without pausing on lock-screen', () => {
    const suspendHandler = readPowerHandler('suspend', 'resume');
    const resumeHandler = readPowerHandler('resume', 'lock-screen');
    const lockHandler = readPowerHandler('lock-screen', 'unlock-screen');
    const unlockHandler = mainSource.slice(mainSource.indexOf("powerMonitor.on('unlock-screen'"));

    expect(suspendHandler.indexOf('mainWatchdogRuntime.suspend()')).toBeGreaterThan(-1);
    expect(suspendHandler.indexOf('mainWatchdogRuntime.suspend()')).toBeLessThan(
      suspendHandler.indexOf("logger.info('power:suspend')")
    );
    expect(resumeHandler.indexOf('mainWatchdogRuntime.resume()')).toBeGreaterThan(-1);
    expect(resumeHandler.indexOf('mainWatchdogRuntime.resume()')).toBeLessThan(
      resumeHandler.indexOf("logger.info('power:resume')")
    );
    expect(lockHandler).not.toContain('mainWatchdogRuntime.');
    expect(unlockHandler).not.toContain('mainWatchdogRuntime.');
  });
});
