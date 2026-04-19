export function hasExplicitAutomatedTestOptIn(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.__brainstrike_e2e_expose_file_explorer_store__ === true &&
    window.navigator.webdriver === true
  );
}

export function shouldExposeAutomatedTestApis(env: Record<string, unknown> | undefined): boolean {
  if (globalThis.process?.env?.['ELECTRON_IS_E2E_TEST'] === 'true') {
    return true;
  }
  if (globalThis.process?.env?.['NODE_ENV'] === 'production' || env?.['MODE'] === 'production') {
    return hasExplicitAutomatedTestOptIn();
  }
  return (
    globalThis.process?.env?.['NODE_ENV'] === 'test' ||
    env?.['DEV'] === true ||
    env?.['MODE'] === 'test'
  );
}
