/**
 * The base-URL environment variable each runtime provider SDK honours, with
 * that SDK's own default. Main-process calls that reach these providers
 * outside the SDK (credential probes, model metadata) resolve their origin
 * here, so they go wherever a real turn would go.
 *
 * Defaults match the installed SDKs: `@ai-sdk/openai` (`OPENAI_BASE_URL`,
 * https://api.openai.com/v1), `@ai-sdk/anthropic` (`ANTHROPIC_BASE_URL`,
 * https://api.anthropic.com/v1) and the OpenRouter gateway
 * (`OPENROUTER_BASE_URL`, https://openrouter.ai/api/v1).
 */
const PROVIDER_BASE_URLS = {
  anthropic: { defaultUrl: 'https://api.anthropic.com/v1', envName: 'ANTHROPIC_BASE_URL' },
  openai: { defaultUrl: 'https://api.openai.com/v1', envName: 'OPENAI_BASE_URL' },
  openrouter: { defaultUrl: 'https://openrouter.ai/api/v1', envName: 'OPENROUTER_BASE_URL' },
} as const;

const ANTHROPIC_BARE_ORIGIN = 'https://api.anthropic.com';

export type BaseUrlProvider = keyof typeof PROVIDER_BASE_URLS;

/** Absolute HTTP(S) base URL, no trailing slash; refuses rather than falling back to the default. */
export function resolveProviderBaseUrl(
  provider: BaseUrlProvider,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const { defaultUrl, envName } = PROVIDER_BASE_URLS[provider];
  const invalid = new Error(
    `${envName} must be an absolute HTTP(S) base URL without credentials, query or fragment`
  );
  let url: URL;
  try {
    url = new URL(env[envName] || defaultUrl);
  } catch {
    throw invalid;
  }
  if (
    !(url.protocol === 'http:' || url.protocol === 'https:') ||
    url.username ||
    url.password ||
    url.href.includes('?') ||
    url.href.includes('#')
  ) {
    throw invalid;
  }
  const base = url.href.replace(/\/$/, '');
  // @ai-sdk/anthropic's normalizeBaseURL versions exactly its bare API origin.
  return provider === 'anthropic' && base === ANTHROPIC_BARE_ORIGIN ? defaultUrl : base;
}
