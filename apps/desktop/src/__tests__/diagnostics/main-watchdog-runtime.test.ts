import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  attemptMainWatchdogBootstrap,
  createMainWatchdogAttachmentLifecycle,
  createMainWatchdogRuntime,
  runMainWatchdogPowerTransition,
} from '../../diagnostics/main-watchdog-runtime';

const ENABLED_CUSTOM_LOGGING = {
  destination: '/custom/brainstrike.log',
  enabled: true,
} as const;

describe('main watchdog runtime', () => {
  function createRuntime() {
    return createMainWatchdogRuntime({ onDeliveryError: vi.fn() });
  }

  it('sends the initial log destination and every successful live reconfiguration', () => {
    const postMessage = vi.fn();
    const runtime = createRuntime();

    expect(() =>
      runtime.configureLogging({ destination: '/before-attach.log', enabled: true })
    ).not.toThrow();
    expect(runtime.configureLogging({ destination: '/before-attach.log', enabled: true })).toBe(
      false
    );

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
    const runtime = createRuntime();

    expect(() => runtime.attach(postMessage, { destination: null, enabled: true })).toThrow(
      'Main watchdog file logging is enabled without a destination'
    );
    expect(postMessage).not.toHaveBeenCalled();

    runtime.attach(postMessage, ENABLED_CUSTOM_LOGGING);
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it('preserves heartbeat and OS suspend/resume message ordering', () => {
    const postMessage = vi.fn();
    const runtime = createRuntime();
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
    const runtime = createRuntime();
    runtime.attach(vi.fn(), ENABLED_CUSTOM_LOGGING);
    runtime.detach();

    expect(runtime.heartbeat()).toBe(false);
    expect(runtime.configureLogging(ENABLED_CUSTOM_LOGGING)).toBe(false);
  });

  it('reports lifecycle and configuration delivery failures without throwing into callers', () => {
    const onDeliveryError = vi.fn();
    const runtime = createMainWatchdogRuntime({ onDeliveryError });
    const workerError = new Error('worker unavailable');
    runtime.attach(vi.fn(), ENABLED_CUSTOM_LOGGING);
    runtime.detach();

    expect(runtime.suspend()).toBe(false);
    expect(runtime.resume()).toBe(false);
    expect(runtime.configureLogging(ENABLED_CUSTOM_LOGGING)).toBe(false);
    expect(onDeliveryError.mock.calls).toEqual([
      [expect.objectContaining({ message: { type: 'suspend' } })],
      [expect.objectContaining({ message: { type: 'resume' } })],
      [
        expect.objectContaining({
          message: { logPath: '/custom/brainstrike.log', type: 'config' },
        }),
      ],
    ]);

    const throwingRuntime = createMainWatchdogRuntime({ onDeliveryError });
    throwingRuntime.attach((message) => {
      if (message.type !== 'config') {
        throw workerError;
      }
    }, ENABLED_CUSTOM_LOGGING);
    expect(throwingRuntime.heartbeat()).toBe(false);
    expect(onDeliveryError).toHaveBeenLastCalledWith({
      error: workerError,
      message: { type: 'heartbeat' },
    });
  });
});

describe('main watchdog bootstrap', () => {
  it('reports a synchronous watchdog startup failure without aborting app startup', () => {
    const startupError = new Error('watchdog bundle missing');
    const onError = vi.fn();

    expect(
      attemptMainWatchdogBootstrap(() => {
        throw startupError;
      }, onError)
    ).toBe(false);
    expect(onError).toHaveBeenCalledWith(startupError);
  });
});

describe('main watchdog power transition', () => {
  it.each([
    'suspend',
    'resume',
  ] as const)('notifies the watchdog before running %s orchestration', (type) => {
    const calls: string[] = [];
    const runtime = {
      resume: () => {
        calls.push('watchdog:resume');
        return true;
      },
      suspend: () => {
        calls.push('watchdog:suspend');
        return true;
      },
    };

    runMainWatchdogPowerTransition(runtime, type, () => {
      calls.push(`power:${type}`);
    });

    expect(calls).toEqual([`watchdog:${type}`, `power:${type}`]);
  });
});

describe('main watchdog attachment lifecycle', () => {
  it('does not detach after initial configuration delivery makes attachment fail', () => {
    const runtime = createMainWatchdogRuntime({ onDeliveryError: vi.fn() });
    const lifecycle = createMainWatchdogAttachmentLifecycle(runtime);
    const configurationError = new Error('initial config delivery failed');

    expect(() =>
      lifecycle.attach(() => {
        throw configurationError;
      }, ENABLED_CUSTOM_LOGGING)
    ).toThrow(configurationError);
    expect(lifecycle.detachIfAttached()).toBe(false);
    expect(() => runtime.detach()).toThrow('Main watchdog runtime is not attached');
  });

  it('detaches exactly once after successful attachment', () => {
    const runtime = createMainWatchdogRuntime({ onDeliveryError: vi.fn() });
    const lifecycle = createMainWatchdogAttachmentLifecycle(runtime);

    lifecycle.attach(vi.fn(), ENABLED_CUSTOM_LOGGING);

    expect(lifecycle.detachIfAttached()).toBe(true);
    expect(lifecycle.detachIfAttached()).toBe(false);
    expect(() => runtime.detach()).toThrow('Main watchdog runtime is not attached');
  });

  it('retains the original attachment after rejecting a duplicate attach', () => {
    const runtime = createMainWatchdogRuntime({ onDeliveryError: vi.fn() });
    const lifecycle = createMainWatchdogAttachmentLifecycle(runtime);

    lifecycle.attach(vi.fn(), ENABLED_CUSTOM_LOGGING);
    expect(() => lifecycle.attach(vi.fn(), ENABLED_CUSTOM_LOGGING)).toThrow(
      'Main watchdog attachment lifecycle is already attached'
    );

    expect(lifecycle.detachIfAttached()).toBe(true);
    expect(lifecycle.detachIfAttached()).toBe(false);
  });
});

describe('main watchdog source wiring', () => {
  const mainSource = fs.readFileSync(path.resolve(import.meta.dirname, '../../main.ts'), 'utf8');

  it('keeps watchdog attachment ahead of renderer startup and cleans up after exit', () => {
    expect(mainSource).toContain('attemptMainWatchdogBootstrap(');
    expect(mainSource).toContain('mainWatchdogAttachment.attach(');
    expect(mainSource.indexOf('mainWatchdogAttachment.attach(')).toBeLessThan(
      mainSource.indexOf('const mainWindow = await createMainWindow()')
    );
    expect(mainSource).toContain('mainWatchdogAttachment.detachIfAttached()');
  });
});
