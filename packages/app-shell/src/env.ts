export function isDbUiEnabled(): boolean {
  try {
    // Prefer global runtime flag (works in Electron renderer and web)
    const g = globalThis as unknown as {
      /* biome-ignore lint/style/useNamingConvention: Vite global convention */
      __VITE_ENABLE_DB_UI__?: unknown;
      process?: { env?: Record<string, string | undefined> };
    };
    if (typeof g?.__VITE_ENABLE_DB_UI__ !== 'undefined') return Boolean(g.__VITE_ENABLE_DB_UI__);
    // Fallback for Node/vitest: use process.env
    const env = g?.process?.env;
    if (env && typeof env['APP_SHELL_DB_UI'] === 'string') return env['APP_SHELL_DB_UI'] === 'true';
  } catch {}
  return false;
}

export function isAssistantUiEnabled(): boolean {
  try {
    const g = globalThis as unknown as {
      /* biome-ignore lint/style/useNamingConvention: Vite global convention */
      __VITE_ASSISTANT_UI__?: unknown;
      process?: { env?: Record<string, string | undefined> };
    };
    if (typeof g?.__VITE_ASSISTANT_UI__ !== 'undefined') return Boolean(g.__VITE_ASSISTANT_UI__);
    const env = g?.process?.env;
    if (env && typeof env['APP_SHELL_ASSISTANT_UI'] === 'string')
      return env['APP_SHELL_ASSISTANT_UI'] === 'true';
  } catch {}
  return false;
}
