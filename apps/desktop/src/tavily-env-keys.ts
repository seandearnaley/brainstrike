/**
 * Re-export of the canonical Tavily env names.
 *
 * The constant MOVED to `@brainstrike/assistant-contract/tavily-env-keys`
 * (BST-1363 review) because settings-ui needs the same list and cannot import
 * from `apps/desktop`; every copy made instead has drifted. This module stays
 * as the desktop-side import surface so the main-process call sites keep a
 * short specifier — it must never redeclare the names.
 */
export {
  TAVILY_ENV_KEYS,
  TAVILY_OVERRIDE_ENV_KEY,
  TAVILY_VENDOR_ENV_KEY,
} from '@brainstrike/assistant-contract/tavily-env-keys';
