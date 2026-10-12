import { describe, expect, it, vi } from 'vitest';

import {
  attemptMainWatchdogBootstrap,
  createMainWatchdogAttachmentLifecycle,
  createMainWatchdogRuntime,
  runMainWatchdogPowerTransition,
  startMainWatchdogBeforeWindow,
} from '../../diagnostics/main-watchdog-runtime';
import {
  createInitialWindowAfterNativeReader,
  observeNativeReaderStartup,
} from '../../native-index-startup-window';

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
  it.each(['suspend', 'resume'] as const)(
    'notifies the watchdog before running %s orchestration',
    (type) => {
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
    }
  );
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

describe('main watchdog window startup', () => {
  it('keeps watchdog attachment ahead of renderer startup and cleans up after exit', async () => {
    const reader = Promise.withResolvers<void>();
    const runtime = createMainWatchdogRuntime({ onDeliveryError: vi.fn() });
    const attachment = createMainWatchdogAttachmentLifecycle(runtime);
    const postMessage = vi.fn();
    const createWindow = vi.fn(async () => ({ id: 1 }));
    const onError = vi.fn();
    // BST-1977: qualify the actual Main startup seam while reader readiness
    // is held, replacing the obsolete createMainWindow source-text assertion.
    const window = startMainWatchdogBeforeWindow(
      () => attachment.attach(postMessage, ENABLED_CUSTOM_LOGGING),
      onError,
      () =>
        createInitialWindowAfterNativeReader(
          observeNativeReaderStartup(reader.promise, onError),
          createWindow,
          vi.fn(),
          () => false
        )
    );
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({
      logPath: '/custom/brainstrike.log',
      type: 'config',
    });
    expect(runtime.heartbeat()).toBe(true);
    await Promise.resolve();
    expect(createWindow).not.toHaveBeenCalled();
    reader.resolve();
    await expect(window).resolves.toEqual({ id: 1 });
    expect(createWindow).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(attachment.detachIfAttached()).toBe(true);
    expect(attachment.detachIfAttached()).toBe(false);
    expect(runtime.heartbeat()).toBe(false);
  });

  it('opens the ready renderer after a reported watchdog bootstrap failure', async () => {
    const error = new Error('Watchdog could not be acquired');
    const onError = vi.fn();
    const createWindow = vi.fn(async () => ({ id: 1 }));
    const window = startMainWatchdogBeforeWindow(
      () => {
        throw error;
      },
      onError,
      () =>
        createInitialWindowAfterNativeReader(
          Promise.resolve({ kind: 'ready' }),
          createWindow,
          vi.fn(),
          () => false
        )
    );
    await expect(window).resolves.toEqual({ id: 1 });
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(createWindow).toHaveBeenCalledOnce();
  });
});
