/**
 * Env vars consulted for the Tavily key before the encrypted keychain (env
 * takes priority). Tavily is NOT a `ProviderId` — it is a search service, not
 * a model provider — so these names cannot come from the provider registry.
 *
 * They live in the CONTRACT rather than in `apps/desktop` because both sides
 * of the boundary need them: the desktop env-file allowlist, the secrets IPC
 * source listing and both web tools on one side; the settings-ui credential
 * inventory and the Environment section's chip→row index on the other.
 * settings-ui cannot import from `apps/desktop`, and every copy that has been
 * made instead has drifted or duplicated — if the lists disagree, a user can
 * set a name one side reads and another side rejects.
 *
 * The override name comes FIRST: that is resolution priority, not cosmetics.
 */

/** App-scoped override, read before the vendor-standard name. */
export const TAVILY_OVERRIDE_ENV_KEY = 'BRAINSTRIKE_TAVILY_API_KEY';

/** Vendor-standard name, and the one shown in the inventory Variable column. */
export const TAVILY_VENDOR_ENV_KEY = 'TAVILY_API_KEY';

/** Both Tavily names in resolution order. Never index this positionally. */
export const TAVILY_ENV_KEYS = [TAVILY_OVERRIDE_ENV_KEY, TAVILY_VENDOR_ENV_KEY] as const;
