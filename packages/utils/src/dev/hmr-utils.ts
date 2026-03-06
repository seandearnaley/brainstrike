/**
 * HMR (Hot Module Replacement) utilities that work safely in both ESM and CJS environments.
 * These functions handle the conditional availability of import.meta and HMR APIs.
 */

export interface HMRModule {
  accept: () => void;
  dispose: (callback: () => void | Promise<void>) => void;
}

interface GlobalWithViteHMR {
  // biome-ignore lint/style/useNamingConvention: Vite's global uses this exact naming
  __vite_hot__?: HMRModule;
}

/**
 * Get the HMR module if available in the current environment.
 * Returns null in CJS builds or when HMR is not available.
 */
export function getHMRModule(): HMRModule | null {
  // Only attempt to access import.meta in environments where it exists
  // This check prevents errors in CJS builds
  if (typeof globalThis !== 'undefined' && '__vite_hot__' in globalThis) {
    try {
      // Use dynamic property access to avoid syntax errors in CJS
      const meta = (globalThis as GlobalWithViteHMR).__vite_hot__;
      if (meta && typeof meta.accept === 'function' && typeof meta.dispose === 'function') {
        return meta;
      }
    } catch {
      // import.meta not available or error accessing it
    }
  }

  // Try the standard import.meta.hot approach for ESM builds
  try {
    // This will be tree-shaken in CJS builds
    const meta = import.meta as unknown as { hot?: HMRModule };
    if (meta?.hot) {
      return meta.hot;
    }
  } catch {
    // import.meta not available in this environment
  }

  return null;
}

/**
 * Set up HMR for a module if HMR is available.
 * Safe to call in any environment - will be a no-op if HMR is not available.
 *
 * @param onAccept - Optional callback to run when the module is accepted
 * @param onDispose - Optional callback to run when the module is being disposed
 */
export function setupHMR(onAccept?: () => void, onDispose?: () => void | Promise<void>): void {
  const hot = getHMRModule();
  if (hot) {
    hot.accept();
    if (onAccept) {
      onAccept();
    }
    if (onDispose) {
      hot.dispose(onDispose);
    }
  }
}

/**
 * Check if HMR is available in the current environment.
 */
export function isHMRAvailable(): boolean {
  return getHMRModule() !== null;
}
