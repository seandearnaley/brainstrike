export const isDevEnv = (): boolean => {
  // Vite uses import.meta.env.MODE, not process.env.NODE_ENV, by default in client code
  // See: https://vitejs.dev/guide/env-and-mode.html#env-variables
  // Type definition in vite-env.d.ts
  // In Node environments (like tests), import.meta.env might be undefined,
  // so we fall back to process.env.NODE_ENV which is commonly set there.
  const envKey = 'NODE_ENV';

  // Try to get Vite environment mode first (browser)
  if (typeof window !== 'undefined') {
    try {
      const meta = import.meta as { env?: Record<string, string> };
      const viteMode = meta.env?.['MODE'];
      if (viteMode !== undefined) {
        return viteMode === 'development';
      }
    } catch {
      // import.meta not available
    }
  }

  // Fallback to Node.js process.env (server/tests) - check if process exists first without
  // triggering a ReferenceError in browser builds
  const envObj = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  if (envObj) {
    return envObj[envKey] === 'development';
  }

  // Default to false if neither environment is available
  return false;
};
