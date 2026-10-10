import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  exit: vi.fn(),
  handlers: new Map<string, (event: { preventDefault(): void }) => void>(),
  quit: vi.fn(),
  quitting: false,
  reportHostFailure: vi.fn(),
}));
const bootstrapEvents = vi.hoisted(() => [] as string[]);
const runtime = vi.hoisted(() => ({
  profile: {
    acquire: vi.fn(async () => {
      bootstrapEvents.push('profile');
    }),
    retire: vi.fn(async (): Promise<void> => undefined),
  },
  singleInstanceLockAcquired: true,
  waitForProfileLaunch: vi.fn(async () => {
    bootstrapEvents.push('fork');
  }),
}));
const appReady = vi.hoisted(() => ({ current: Promise.withResolvers<void>() }));
const initializeDesktopEnvironment = vi.hoisted(() =>
  vi.fn(() => {
    bootstrapEvents.push('environment');
  })
);

vi.mock('electron', () => ({
  app: {
    exit: state.exit,
    getAppPath: vi.fn(() => resolve('/mock/app')),
    getPath: vi.fn(() => '/mock/user-data'),
    isPackaged: false,
    on: (event: string, handler: (event: { preventDefault(): void }) => void) =>
      state.handlers.set(event, handler),
    quit: state.quit,
    removeListener: (event: string) => state.handlers.delete(event),
    whenReady: vi.fn(() => appReady.current.promise),
  },
  dialog: { showErrorBox: vi.fn() },
}));

vi.mock('../../desktop-bootstrap-runtime', () => ({ getDesktopBootstrapRuntime: () => runtime }));

vi.mock('../../desktop-shutdown-state', () => ({
  isDesktopShuttingDown: () => state.quitting,
  markDesktopShuttingDown: () => {
    state.quitting = true;
  },
}));

vi.mock('../../desktop-env', () => ({ initializeDesktopEnvironment }));

beforeEach(() => {
  vi.resetModules();
  bootstrapEvents.length = 0;
  state.quitting = false;
  state.handlers.clear();
  state.exit.mockReset();
  state.reportHostFailure.mockReset();
  state.quit.mockReset();
  runtime.profile.acquire.mockReset().mockImplementation(async () => {
    bootstrapEvents.push('profile');
  });
  runtime.profile.retire.mockReset().mockResolvedValue(undefined);
  runtime.waitForProfileLaunch.mockReset().mockImplementation(async () => {
    bootstrapEvents.push('fork');
  });
  appReady.current = Promise.withResolvers<void>();
  vi.doMock('../../main', () => {
    bootstrapEvents.push('main');
    return { reportAgentHostStartupFailure: state.reportHostFailure };
  });
});

it('keeps the full Main graph unloaded until Electron is ready for host startup', async () => {
  await import('../../main-bootstrap');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(bootstrapEvents).toEqual(['environment']);
});

it('initializes desktop environment files before evaluating the main runtime graph', async () => {
  appReady.current.resolve();
  await import('../../main-bootstrap');
  await vi.waitFor(() => {
    expect(bootstrapEvents).toEqual(['environment', 'profile', 'fork', 'main']);
  });
});

it('waits for the fork milestone before evaluating Main while host readiness is pending', async () => {
  const forked = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  runtime.waitForProfileLaunch.mockImplementationOnce(() => forked.promise);
  runtime.profile.acquire.mockImplementationOnce(() => ready.promise);
  appReady.current.resolve();
  await import('../../main-bootstrap');
  await vi.waitFor(() => expect(runtime.waitForProfileLaunch).toHaveBeenCalledOnce());
  expect(bootstrapEvents).toEqual(['environment']);
  forked.resolve();
  await vi.waitFor(() => expect(bootstrapEvents).toEqual(['environment', 'main']));
  ready.resolve();
});

it('joins the profile when full Main evaluation rejects before reporting startup failure', async () => {
  const released = Promise.withResolvers<void>();
  runtime.profile.retire.mockImplementationOnce(() => released.promise);
  vi.doMock('../../main', () => {
    throw new Error('Main binding failed');
  });
  appReady.current.resolve();
  await import('../../main-bootstrap');
  await vi.waitFor(() => expect(runtime.profile.retire).toHaveBeenCalledOnce());
  expect(state.quitting).toBe(true);
  expect(state.exit).not.toHaveBeenCalled();
  released.resolve();
  await vi.waitFor(() => expect(state.exit).toHaveBeenCalledWith(1));
});

it('keeps the early quit join while full Main is still loading', async () => {
  const loaded = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  vi.doMock('../../main', async () => {
    await loaded.promise;
    return { reportAgentHostStartupFailure: state.reportHostFailure };
  });
  runtime.profile.retire.mockImplementationOnce(() => released.promise);
  appReady.current.resolve();
  await import('../../main-bootstrap');
  await vi.waitFor(() => expect(runtime.waitForProfileLaunch).toHaveBeenCalledOnce());
  const preventDefault = vi.fn();
  state.handlers.get('before-quit')?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(runtime.profile.retire).toHaveBeenCalledOnce();
  expect(state.quit).not.toHaveBeenCalled();
  released.resolve();
  await vi.waitFor(() => expect(state.quit).toHaveBeenCalledOnce());
  loaded.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

it('hands a refused early host start to Main reporting while preserving the shell', async () => {
  const failure = new Error('Host Root is held by another app');
  runtime.profile.acquire.mockRejectedValueOnce(failure);
  runtime.waitForProfileLaunch.mockRejectedValueOnce(failure);
  appReady.current.resolve();
  await import('../../main-bootstrap');
  await vi.waitFor(() => expect(state.reportHostFailure).toHaveBeenCalledWith(failure));
  expect(runtime.profile.acquire).toHaveBeenCalledOnce();
  expect(bootstrapEvents).toEqual(['environment', 'main']);
  expect(state.exit).not.toHaveBeenCalled();
});
