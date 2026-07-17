/**
 * Abort Controllers Hook
 *
 * Manages abort controllers for cancellable file tree operations.
 * Provides separate controllers for root loading and child directory loading.
 *
 * @module use-abort-controllers
 */

import { useCallback, useRef } from 'react';

export interface UseAbortControllersReturn {
  /** Cancel every child loading operation without affecting the root load */
  cancelAllChildLoading: () => void;
  /** Cancel all loading operations */
  cancelAllLoading: () => void;
  /** Cancel a specific child loading operation */
  cancelChildLoading: (path: string) => void;
  /** Cancel the root loading operation */
  cancelRootLoading: () => void;
  /** Abort controllers for child directory loading operations */
  childAbortControllersRef: React.RefObject<Map<string, AbortController>>;
  /** Create and register an abort controller for a path */
  createAbortController: (path: string | null) => AbortController;
  /** Remove a child abort controller after completion */
  removeChildController: (path: string, controller?: AbortController) => void;
  /** Abort controller for root loading operation */
  rootAbortControllerRef: React.RefObject<AbortController | null>;
}

/**
 * Hook for managing abort controllers for file tree operations.
 *
 * Provides:
 * - Separate controller for root directory loading
 * - Map of controllers for child directory loading (keyed by path)
 * - Automatic cancellation of previous operation when starting new one
 *
 * @returns Abort controller management functions
 */
export function useAbortControllers(): UseAbortControllersReturn {
  // Root loading abort controller
  const rootAbortControllerRef = useRef<AbortController | null>(null);

  // Child directory loading abort controllers (keyed by path)
  const childAbortControllersRef = useRef<Map<string, AbortController>>(new Map());

  /**
   * Create and register an abort controller.
   * If path is null, creates a root controller.
   * Cancels any existing controller for the same path/root.
   */
  const createAbortController = useCallback((path: string | null): AbortController => {
    const controller = new AbortController();

    if (path === null) {
      // Root controller
      rootAbortControllerRef.current?.abort();
      rootAbortControllerRef.current = controller;
    } else {
      // Child controller
      childAbortControllersRef.current.get(path)?.abort();
      childAbortControllersRef.current.set(path, controller);
    }

    return controller;
  }, []);

  /**
   * Cancel the root loading operation.
   */
  const cancelRootLoading = useCallback(() => {
    rootAbortControllerRef.current?.abort();
    rootAbortControllerRef.current = null;
  }, []);

  /**
   * Cancel a specific child loading operation.
   */
  const cancelChildLoading = useCallback((path: string) => {
    childAbortControllersRef.current.get(path)?.abort();
    childAbortControllersRef.current.delete(path);
  }, []);

  /**
   * Cancel every child directory load while preserving an independent root load.
   */
  const cancelAllChildLoading = useCallback(() => {
    for (const controller of childAbortControllersRef.current.values()) {
      controller.abort();
    }
    childAbortControllersRef.current.clear();
  }, []);

  /**
   * Cancel all loading operations (root and all children).
   */
  const cancelAllLoading = useCallback(() => {
    cancelRootLoading();
    cancelAllChildLoading();
  }, [cancelAllChildLoading, cancelRootLoading]);

  /**
   * Remove a child abort controller after operation completes.
   */
  const removeChildController = useCallback((path: string, controller?: AbortController) => {
    const currentController = childAbortControllersRef.current.get(path);
    if (!currentController) {
      return;
    }
    if (controller && currentController !== controller) {
      return;
    }
    childAbortControllersRef.current.delete(path);
  }, []);

  return {
    cancelAllChildLoading,
    cancelAllLoading,
    cancelChildLoading,
    cancelRootLoading,
    childAbortControllersRef,
    createAbortController,
    removeChildController,
    rootAbortControllerRef,
  };
}
