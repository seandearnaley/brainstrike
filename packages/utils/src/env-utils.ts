// Helper function to safely get environment mode
function getEnvironmentMode(): string | undefined {
  // In browser environments with Vite, check for import.meta.env
  // We use a function to isolate the import.meta usage
  if (typeof window !== 'undefined') {
    try {
      // This will only be available in ESM/Vite environments
      const meta = import.meta as { env?: Record<string, string> };
      const modeKey = 'MODE';
      return meta.env?.[modeKey];
    } catch {
      // import.meta not available
      return;
    }
  }

  // In Node.js environments, return undefined so we fall back to process.env
  return;
}

export function isDevEnv(): boolean {
  // Vite uses import.meta.env.MODE, not process.env.NODE_ENV, by default in client code
  // See: https://vitejs.dev/guide/env-and-mode.html#env-variables
  // Type definition in vite-env.d.ts
  // In Node environments (like tests), import.meta.env might be undefined,
  // so we fall back to process.env.NODE_ENV which is commonly set there.
  const envKey = 'NODE_ENV';

  // Try to get Vite environment mode first (browser)
  const viteMode = getEnvironmentMode();

  if (viteMode !== undefined) {
    return viteMode === 'development';
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
}
