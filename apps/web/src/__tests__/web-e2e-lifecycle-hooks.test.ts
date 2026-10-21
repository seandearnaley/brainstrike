import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWebE2ELifecycleHooks, type WebE2ELifecycleHooks } from '../web-e2e-lifecycle-hooks';

const initialRegistryState = useModelRegistryStore.getState();
let uninstall: () => void = () => undefined;

function installHooks(): WebE2ELifecycleHooks {
  vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
  uninstall = installWebE2ELifecycleHooks();
  const hooks = window.__brainstrikeWebE2ELifecycle__;
  if (!hooks) {
    throw new Error('Expected the webdriver lifecycle hooks to be installed');
  }
  return hooks;
}

/** Lets every already-queued promise reaction run. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
  useModelRegistryStore.setState(initialRegistryState, true);
});

describe('joinModelRegistry (BST-2291)', () => {
  it('stays pending while the registry loads and resolves when it has loaded', async () => {
    const hooks = installHooks();
    let joined = false;
    const join = hooks.joinModelRegistry().then(() => {
      joined = true;
    });

    useModelRegistryStore.setState({ isLoading: true });
    await flushMicrotasks();
    expect(joined).toBe(false);

    useModelRegistryStore.setState({ hasLoaded: true, isLoading: false });
    await join;
    expect(joined).toBe(true);
  });

  it('resolves at once when the registry has already loaded', async () => {
    useModelRegistryStore.setState({ hasLoaded: true });
    const hooks = installHooks();

    await expect(hooks.joinModelRegistry()).resolves.toBeUndefined();
  });

  it('rejects with the registry error when the load fails', async () => {
    const hooks = installHooks();
    const join = hooks.joinModelRegistry();

    useModelRegistryStore.setState({ error: 'Model registry unavailable', isLoading: false });

    await expect(join).rejects.toThrow('Model registry unavailable');
  });

  it('rejects at once when the registry already failed', async () => {
    useModelRegistryStore.setState({ error: 'Model registry unavailable' });
    const hooks = installHooks();

    await expect(hooks.joinModelRegistry()).rejects.toThrow('Model registry unavailable');
  });
});
