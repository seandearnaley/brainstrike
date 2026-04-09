/**
 * Inline Fixture Subscription
 *
 * Sets up a Zustand store subscription to manage inline fixture
 * loading/clearing outside the React component tree. This ensures
 * the fixture activates regardless of which page/route is active.
 *
 * Also exposes `window.__BRAINSTRIKE_LOAD_FIXTURE__` and
 * `window.__BRAINSTRIKE_CLEAR_FIXTURE__` for automated testing
 * tools (Playwright, Chrome DevTools MCP, Claude Code) that
 * cannot interact with the native directory picker.
 *
 * @see https://github.com/microsoft/playwright/issues/11288
 */

import type { FileSystemAdapter } from '@brainstrike/file-system';
import {
  type DirectoryHandle,
  type FixtureCapableFileSystemAdapter,
  type FixtureDefinition,
  type FixtureLoadOptions,
  isFixtureCapableAdapter,
} from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { StoreApi } from 'zustand';

const logger = createLogger('InlineFixtureSubscription');

function hasExplicitAutomatedTestOptIn(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return (
    window.__brainstrike_e2e_expose_file_explorer_store__ === true &&
    window.navigator.webdriver === true
  );
}

function shouldExposeFixtureTestingApi(): boolean {
  const env = (
    import.meta as ImportMeta & {
      env?: Record<string, unknown>;
    }
  ).env;
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

declare global {
  interface Window {
    /** Clear the dev fixture and reset the file explorer */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_CLEAR_FIXTURE__?: (() => void | Promise<void>) | undefined;
    /** Load the built-in dev fixture into the file explorer (bypasses native directory picker) */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_LOAD_FIXTURE__?:
      | ((
          fixture?: FixtureDefinition,
          options?: FixtureLoadOptions
        ) => DirectoryHandle | Promise<DirectoryHandle | null> | null | undefined)
      | undefined;
    // biome-ignore lint/style/useNamingConvention: E2E init-script flag uses double underscores by convention
    __brainstrike_e2e_expose_file_explorer_store__?: boolean | undefined;
  }
}

/**
 * Sets up a store subscription that loads/clears the inline fixture
 * whenever `devInlineFixtureEnabled` changes.
 *
 * Returns an unsubscribe function for cleanup (e.g., HMR dispose).
 */
export function setupInlineFixtureSubscription(
  store: StoreApi<FileExplorerState>,
  fileSystemAdapter: FileSystemAdapter
): () => void {
  if (!isFixtureCapableAdapter(fileSystemAdapter)) {
    logger.debug('Adapter does not support inline fixtures, skipping subscription');
    return () => {};
  }

  const adapter = fileSystemAdapter as FixtureCapableFileSystemAdapter;
  let isProcessing = false;
  let suppressNextSubscription = false;

  const applyFixtureState = async (
    enabled: boolean,
    fixture?: FixtureDefinition,
    options?: FixtureLoadOptions
  ): Promise<DirectoryHandle | null> => {
    if (isProcessing) {
      return enabled ? store.getState().rootDirectoryHandle : null;
    }
    isProcessing = true;

    try {
      if (enabled) {
        adapter.setInlineFixtureOptions?.(options);
        const handle = await adapter.loadInlineFixture(fixture);
        store.getState().setRootDirectoryHandle(handle);
        logger.info('Inline fixture loaded');
        return handle;
      }
      await adapter.clearInlineFixture();
      adapter.setInlineFixtureOptions?.();
      store.getState().setRootDirectoryHandle(null);
      logger.info('Inline fixture cleared');
      return null;
    } catch (error) {
      logger.warn('Failed to toggle inline fixture', { error, enabled });
      // Roll back the toggle without re-entering the subscription loop.
      suppressNextSubscription = true;
      store.getState().setDevInlineFixtureEnabled(!enabled);
      return null;
    } finally {
      isProcessing = false;
    }
  };

  const safelyApplyFixtureState = (
    enabled: boolean,
    fixture?: FixtureDefinition,
    options?: FixtureLoadOptions
  ): void => {
    void applyFixtureState(enabled, fixture, options).catch((error) => {
      logger.error('Inline fixture toggle crashed outside guarded flow', { error, enabled });
    });
  };

  // Track previous state to detect actual changes
  let previousEnabled = store.getState().devInlineFixtureEnabled;

  // If fixture was enabled before subscription started (e.g., persisted state),
  // apply it immediately
  if (previousEnabled && !adapter.isInlineFixtureActive()) {
    safelyApplyFixtureState(true);
  }

  const unsubscribe = store.subscribe((state) => {
    const currentEnabled = state.devInlineFixtureEnabled;
    if (suppressNextSubscription) {
      suppressNextSubscription = false;
      previousEnabled = currentEnabled;
      return;
    }
    if (currentEnabled === previousEnabled) {
      return;
    }
    previousEnabled = currentEnabled;
    safelyApplyFixtureState(currentEnabled);
  });

  // Expose global testing API
  if (typeof window !== 'undefined') {
    if (shouldExposeFixtureTestingApi()) {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = async (
        fixture?: FixtureDefinition,
        options?: FixtureLoadOptions
      ) => {
        suppressNextSubscription = true;
        store.getState().setDevInlineFixtureEnabled(true);
        return await applyFixtureState(true, fixture, options);
      };
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = async () => {
        suppressNextSubscription = true;
        store.getState().setDevInlineFixtureEnabled(false);
        await applyFixtureState(false);
      };
    } else {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
    }
  }

  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
    }
  };
}
