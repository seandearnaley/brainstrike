/**
 * Tavily credential identity, shared by the web-search tool, the web-extract
 * tool, and the secrets IPC surface that tells Settings which source the
 * runtime will use. Tavily is NOT a `ProviderId` (it is a search service, not a
 * model provider), so it stays out of the model registry and is keyed directly
 * in the secrets store by this id.
 */
export const TAVILY_SECRET_PROVIDER = 'tavily' as const;

/** Env vars consulted before the encrypted keychain (env takes priority). */
export const TAVILY_ENV_KEYS = ['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY'] as const;

/**
 * The env var NAME (never its value) currently supplying the Tavily key, or
 * undefined when none is set.
 */
export function resolveTavilyEnvVarName(): string | undefined {
  for (const envKey of TAVILY_ENV_KEYS) {
    if ((process.env[envKey] ?? '').trim().length > 0) {
      return envKey;
    }
  }
  return;
}
