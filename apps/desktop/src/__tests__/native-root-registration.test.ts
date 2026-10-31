import {
  NativeAuthorityTransitionError,
  NativeIndexSetupRequiredError,
} from '@brainstrike/assistant-service/node-native-text-services';
import { expect, it, vi } from 'vitest';
import { createNativeRootRegistration } from '../native-root-registration';

function fixture() {
  const dependencies = {
    isShuttingDown: vi.fn(() => false),
    reconfigureRoots: vi.fn(async () => {}),
    reportError: vi.fn(),
    transition: vi.fn(async (operation: () => Promise<void>) => await operation()),
  };
  return { dependencies, registration: createNativeRootRegistration(dependencies) };
}

it('acknowledges only after the existing fenced reconfiguration settles', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<void>();
  f.dependencies.reconfigureRoots.mockReturnValue(pending.promise);
  const acknowledged = vi.fn();
  const registration = f.registration.rootsRegistered().then(acknowledged);
  await vi.waitFor(() => expect(f.dependencies.reconfigureRoots).toHaveBeenCalledOnce());
  expect(f.dependencies.transition).toHaveBeenCalledOnce();
  expect(acknowledged).not.toHaveBeenCalled();
  pending.resolve();
  await registration;
  expect(acknowledged).toHaveBeenCalledOnce();
});

it('retains typed setup-required reporting as a completed re-evaluation', async () => {
  const f = fixture();
  const setup = new NativeIndexSetupRequiredError('Choose a search mode.');
  f.dependencies.reconfigureRoots.mockRejectedValue(setup);
  await expect(f.registration.rootsRegistered()).resolves.toBeUndefined();
  expect(f.dependencies.reportError).toHaveBeenCalledWith(expect.any(String), setup);
});

it('reports and rejects genuine activation failure', async () => {
  const f = fixture();
  const failure = new Error('Native writer unavailable');
  f.dependencies.reconfigureRoots.mockRejectedValue(failure);
  await expect(f.registration.rootsRegistered()).rejects.toBe(failure);
  expect(f.dependencies.reportError).toHaveBeenCalledWith(expect.any(String), failure);
});

it('rechecks shutdown after the existing transition queue admits the notification', async () => {
  const f = fixture();
  const admission = Promise.withResolvers<void>();
  f.dependencies.transition.mockImplementation(async (operation) => {
    await admission.promise;
    return await operation();
  });
  const registration = f.registration.rootsRegistered();
  f.dependencies.isShuttingDown.mockReturnValue(true);
  admission.resolve();
  await expect(registration).rejects.toBeInstanceOf(NativeAuthorityTransitionError);
  expect(f.dependencies.reconfigureRoots).not.toHaveBeenCalled();
  expect(f.dependencies.reportError).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(NativeAuthorityTransitionError)
  );
});

it('reopens once for the notifications that arrive while a re-read runs', async () => {
  const f = fixture();
  let queue = Promise.resolve();
  f.dependencies.transition.mockImplementation((operation) => {
    const run = queue.then(operation);
    queue = run.catch(() => undefined);
    return run;
  });
  const running = Promise.withResolvers<void>();
  f.dependencies.reconfigureRoots.mockReturnValueOnce(running.promise);
  const first = f.registration.rootsRegistered();
  await vi.waitFor(() => expect(f.dependencies.reconfigureRoots).toHaveBeenCalledOnce());
  // One folder change notifies several times; a re-read that starts after them reads them all.
  const later = [1, 2, 3].map(() => f.registration.rootsRegistered());
  running.resolve();
  await Promise.all([first, ...later]);
  expect(f.dependencies.reconfigureRoots).toHaveBeenCalledTimes(2);
});
