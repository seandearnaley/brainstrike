import { expect, it, vi } from 'vitest';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';
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

it('ends quietly when the app quits while the registration waits on the transition queue', async () => {
  const f = fixture();
  const admission = Promise.withResolvers<void>();
  f.dependencies.transition.mockImplementation(async (operation) => {
    await admission.promise;
    return await operation();
  });
  const registration = f.registration.rootsRegistered();
  f.dependencies.isShuttingDown.mockReturnValue(true);
  admission.resolve();
  // The roots are committed; the next start's activation reads them.
  await expect(registration).resolves.toBeUndefined();
  expect(f.dependencies.reconfigureRoots).not.toHaveBeenCalled();
  expect(f.dependencies.reportError).not.toHaveBeenCalled();
});

it('ends quietly when the quit retires the index the registration was waiting on', async () => {
  const f = fixture();
  f.dependencies.transition.mockImplementation(async () => {
    f.dependencies.isShuttingDown.mockReturnValue(true);
    throw new NativeAuthorityTransitionError('Native authority retired during shutdown.');
  });
  await expect(f.registration.rootsRegistered()).resolves.toBeUndefined();
  expect(f.dependencies.reportError).not.toHaveBeenCalled();
});

it('reports and rejects a transition refusal outside a quit', async () => {
  const f = fixture();
  const refusal = new NativeAuthorityTransitionError('Native authority is transitioning.');
  f.dependencies.transition.mockRejectedValue(refusal);
  await expect(f.registration.rootsRegistered()).rejects.toBe(refusal);
  expect(f.dependencies.reportError).toHaveBeenCalledWith(expect.any(String), refusal);
});
