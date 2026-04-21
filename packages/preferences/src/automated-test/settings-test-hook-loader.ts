declare global {
  interface Window {
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_enable_settings_test_api__?: boolean;
  }
}

function shouldAttemptSettingsTestHookInstall(env: Record<string, unknown> | undefined): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  if (globalThis.process?.env?.['ELECTRON_IS_E2E_TEST'] === 'true') {
    return true;
  }
  if (window.__brainstrike_e2e_enable_settings_test_api__ === true) {
    return true;
  }
  return (
    globalThis.process?.env?.['NODE_ENV'] === 'test' ||
    env?.['DEV'] === true ||
    env?.['MODE'] === 'test'
  );
}

export function installSettingsTestHooksIfNeeded(
  env: Record<string, unknown> | undefined
): () => void {
  if (!shouldAttemptSettingsTestHookInstall(env)) {
    return () => {};
  }

  let disposed = false;
  let cleanup = () => {};

  void import('../testing/e2e-settings-test-overrides')
    .then(({ installSettingsTestHookApi }) => {
      if (disposed) {
        return;
      }
      cleanup = installSettingsTestHookApi(env);
    })
    .catch((error: unknown) => {
      queueMicrotask(() => {
        throw error;
      });
    });

  return () => {
    disposed = true;
    cleanup();
  };
}
