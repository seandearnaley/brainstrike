export function isDevEnv(): boolean {
  // Vite uses import.meta.env.MODE, not process.env.NODE_ENV, by default in client code
  // See: https://vitejs.dev/guide/env-and-mode.html#env-variables
  // Type definition in vite-env.d.ts
  // In Node environments (like tests), import.meta.env might be undefined,
  // so we fall back to process.env.NODE_ENV which is commonly set there.
  const envKey = 'NODE_ENV';
  const meta = import.meta as { env?: Record<string, string> };
  // biome-ignore lint/complexity/useLiteralKeys: property comes from index signature
  const mode = meta.env?.['MODE'];

  // Check Vite environment first (browser)
  if (mode !== undefined) {
    return mode === 'development';
  }

  // Fallback to Node.js process.env (server/tests) - check if process exists first
  if (typeof process !== 'undefined' && process.env) {
    return process.env[envKey] === 'development';
  }

  // Default to false if neither environment is available
  return false;
}
