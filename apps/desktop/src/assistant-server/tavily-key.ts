import {
  createTavilyKeyResolver,
  TAVILY_SECRET_PROVIDER,
} from '@brainstrike/host-capabilities/native-tools';
import { getSecretsService } from '../secrets';

export { TAVILY_SECRET_PROVIDER };

/**
 * Main's Tavily key for the tools Main still executes (legacy threads, web
 * extract) and its legacy verification route: env first, then Main's view of
 * the profile store. Host-executed web search reads the host's own store.
 */
export const resolveTavilyApiKeyFromKeychain = createTavilyKeyResolver(process.env, (account) =>
  getSecretsService().getKey(account)
);
