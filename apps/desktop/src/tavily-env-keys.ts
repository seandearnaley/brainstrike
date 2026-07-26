/**
 * Env vars consulted for the Tavily key before the encrypted keychain (env
 * takes priority). Tavily is NOT a `ProviderId` — it is a search service, not a
 * model provider — so these names cannot come from the provider registry and
 * live here instead of being repeated at each call site.
 *
 * The env-file allowlist, the secrets IPC source listing, and both web tools
 * MUST read the same list: if they drift, a user can set a name one side reads
 * and another side rejects.
 */
export const TAVILY_ENV_KEYS = ['BRAINSTRIKE_TAVILY_API_KEY', 'TAVILY_API_KEY'] as const;
