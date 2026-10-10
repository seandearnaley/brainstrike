import { expect, it, vi } from 'vitest';
import { NativeAuthorityTransitionError } from '../native-authority-transition';
import { NativeIndexSetupRequiredError } from '../native-index-setup-required';
import { createNativeRootRegistration } from '../native-root-registration';

function fixture() {
  const dependencies = {
    isShuttingDown: vi.fn(() => false),
    reconfigure: vi.fn(async () => {}),
    reportError: vi.fn(),
    transition: vi.fn(async (operation: () => Promise<void>) => await operation()),
  };
  return { dependencies, registration: createNativeRootRegistration(dependencies) };
}

it('acknowledges only after the existing fenced reconfiguration settles', async () => {
  const f = fixture();
  const pending = Promise.withResolvers<void>();
  f.dependencies.reconfigure.mockReturnValue(pending.promise);
  const acknowledged = vi.fn();
  const registration = f.registration.rootsRegistered().then(acknowledged);
  await vi.waitFor(() => expect(f.dependencies.reconfigure).toHaveBeenCalledOnce());
  expect(f.dependencies.transition).toHaveBeenCalledOnce();
  expect(acknowledged).not.toHaveBeenCalled();
  pending.resolve();
  await registration;
  expect(acknowledged).toHaveBeenCalledOnce();
});

it('retains typed setup-required reporting as a completed re-evaluation', async () => {
  const f = fixture();
  const setup = new NativeIndexSetupRequiredError('Choose a search mode.');
  f.dependencies.reconfigure.mockRejectedValue(setup);
  await expect(f.registration.rootsRegistered()).resolves.toBeUndefined();
  expect(f.dependencies.reportError).toHaveBeenCalledWith(expect.any(String), setup);
});

it('reports and rejects genuine activation failure', async () => {
  const f = fixture();
  const failure = new Error('Native writer unavailable');
  f.dependencies.reconfigure.mockRejectedValue(failure);
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
  expect(f.dependencies.reconfigure).not.toHaveBeenCalled();
  expect(f.dependencies.reportError).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(NativeAuthorityTransitionError)
  );
});
