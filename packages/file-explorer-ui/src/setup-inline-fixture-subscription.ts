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
  type FixtureCapableFileSystemAdapter,
  isFixtureCapableAdapter,
} from '@brainstrike/file-system';
import type { FileExplorerState } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import type { StoreApi } from 'zustand';

const logger = createLogger('InlineFixtureSubscription');

declare global {
  interface Window {
    /** Clear the dev fixture and reset the file explorer */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_CLEAR_FIXTURE__?: (() => void) | undefined;
    /** Load the built-in dev fixture into the file explorer (bypasses native directory picker) */
    // biome-ignore lint/style/useNamingConvention: Global test API uses double underscores for clarity
    __BRAINSTRIKE_LOAD_FIXTURE__?: (() => void) | undefined;
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

  const applyFixtureState = async (enabled: boolean) => {
    if (isProcessing) {
      return;
    }
    isProcessing = true;

    try {
      if (enabled) {
        const handle = await adapter.loadInlineFixture();
        store.getState().setRootDirectoryHandle(handle);
        logger.info('Inline fixture loaded');
      } else {
        await adapter.clearInlineFixture();
        store.getState().setRootDirectoryHandle(null);
        logger.info('Inline fixture cleared');
      }
    } catch (error) {
      logger.warn('Failed to toggle inline fixture', { error, enabled });
      // Rollback: revert the store to the opposite state
      store.getState().setDevInlineFixtureEnabled(!enabled);
    } finally {
      isProcessing = false;
    }
  };

  const safelyApplyFixtureState = (enabled: boolean): void => {
    void applyFixtureState(enabled).catch((error) => {
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
    if (currentEnabled === previousEnabled) {
      return;
    }
    previousEnabled = currentEnabled;
    safelyApplyFixtureState(currentEnabled);
  });

  // Expose global testing API
  if (typeof window !== 'undefined') {
    window.__BRAINSTRIKE_LOAD_FIXTURE__ = () => {
      store.getState().setDevInlineFixtureEnabled(true);
    };
    window.__BRAINSTRIKE_CLEAR_FIXTURE__ = () => {
      store.getState().setDevInlineFixtureEnabled(false);
    };
  }

  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') {
      window.__BRAINSTRIKE_LOAD_FIXTURE__ = undefined;
      window.__BRAINSTRIKE_CLEAR_FIXTURE__ = undefined;
    }
  };
}
