import { threadWorkspaceNavigation } from '@brainstrike/app-shell/thread-workspace-navigation';
import { prepareRendererClose } from '@brainstrike/app-state/renderer-close';
import {
  resolveAssistantMemoryResourceId,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';

/**
 * Document lifecycle acknowledgements a webdriver spec joins around a reload (BST-2288).
 * They are installed before the first render, so unlike the database-gated
 * `__brainstrikeWebE2ETestHooks__` they exist while the database is still booting.
 */
export interface WebE2ELifecycleHooks {
  /**
   * Resolves once the thread-workspace coordinator has applied the ACTIVE thread's stored
   * workspace to the live stores; rejects with the failure when loading it fails.
   */
  readonly joinActiveThreadWorkspace: () => Promise<void>;
  /**
   * The flushed unload desktop runs before every reload it owns (ADR-0026 R1): fences the UI
   * and joins every durable writer's flush. A browser cannot join an unload, so a spec that
   * asserts state across `page.reload()` prepares it first.
   */
  readonly prepareReload: () => Promise<void>;
}

declare global {
  interface Window {
    __brainstrikeWebE2ELifecycle__?: WebE2ELifecycleHooks;
  }
}

async function joinActiveThreadWorkspace(): Promise<void> {
  const resourceId = resolveAssistantMemoryResourceId();
  const threadId = useAssistantThreadStore.getState().activeThreadIdByResourceId[resourceId];
  if (!threadId) {
    throw new Error('No active thread: there is no thread workspace to join.');
  }
  await threadWorkspaceNavigation.whenReady(resourceId, threadId);
}

/** Installs the hooks under webdriver automation only; returns their uninstall. */
export function installWebE2ELifecycleHooks(): () => void {
  if (window.navigator.webdriver !== true) {
    return () => undefined;
  }
  const hooks: WebE2ELifecycleHooks = {
    joinActiveThreadWorkspace,
    prepareReload: prepareRendererClose,
  };
  window.__brainstrikeWebE2ELifecycle__ = hooks;
  return () => {
    if (window.__brainstrikeWebE2ELifecycle__ === hooks) {
      Reflect.deleteProperty(window, '__brainstrikeWebE2ELifecycle__');
    }
  };
}
