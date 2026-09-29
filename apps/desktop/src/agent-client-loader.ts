import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProviderDefinition, SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/logging';

type AgentClientModule = typeof import('@brainstrike/agent/client');

let cachedAgentClient: AgentClientModule | null | undefined;
let fallbackNotified = false;
const logger = createLogger('AgentClientLoader');

// BST-1361 two-name scheme: BRAINSTRIKE_* override first, vendor name second.
// Deprecated aliases are deliberately ABSENT — they must never authenticate,
// in the fallback path included. Pinned against the agent SOURCE by
// __tests__/main/agent-client-loader.test.ts.
const FALLBACK_ENV_KEYS: Record<SupportedProvider, readonly string[]> = {
  anthropic: ['BRAINSTRIKE_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  bedrock: ['BRAINSTRIKE_BEDROCK_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK'],
  cohere: ['BRAINSTRIKE_COHERE_API_KEY', 'COHERE_API_KEY'],
  google: ['BRAINSTRIKE_GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  lmstudio: [], // Local runtime provider, auto-discovered on localhost
  local: [], // Local provider runs in-browser, no API key needed
  ollama: [], // Local runtime provider, auto-discovered on localhost
  openai: ['BRAINSTRIKE_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  // BST-1356: ChatGPT-subscription auth is interactive OAuth only. No
  // environment variable can authenticate it, by construction (legal gate
  // constraint 4) — an env key here would be a headless back door.
  'openai-codex': [],
  openrouter: ['BRAINSTRIKE_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
  voyage: ['BRAINSTRIKE_VOYAGE_API_KEY', 'VOYAGE_API_KEY'],
};

/**
 * Registry DECLARATION order — must match `@brainstrike/agent/client`
 * `listProviders()`: `__tests__/main/agent-client-loader.test.ts` pins the
 * loader's output against the agent SOURCE, and CI runs with agent's dist
 * ABSENT, so this fallback list is what that order-sensitive assertion sees
 * (PR #2513 review, finding 2 — Object.keys of the Biome-sorted Record broke
 * it). The `satisfies` rejects entries that are not FALLBACK_ENV_KEYS keys.
 */
const FALLBACK_PROVIDER_ORDER = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'cohere',
  'voyage',
  'bedrock',
  'openai-codex',
  'local',
  'ollama',
  'lmstudio',
] as const satisfies readonly (keyof typeof FALLBACK_ENV_KEYS)[];

// Compile-time pin for the OTHER direction: this annotation collapses to
// `never` whenever a FALLBACK_ENV_KEYS key (i.e. any SupportedProvider —
// the Record is exhaustive) is missing from the ordered tuple, so a newly
// added provider cannot silently skip the fallback list.
const FALLBACK_PROVIDERS: Exclude<
  keyof typeof FALLBACK_ENV_KEYS,
  (typeof FALLBACK_PROVIDER_ORDER)[number]
> extends never
  ? readonly SupportedProvider[]
  : never = FALLBACK_PROVIDER_ORDER;

function tryRequireAgentClient(path: string): AgentClientModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path) as AgentClientModule;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string };
    if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
      return null;
    }
    throw error;
  }
}

function shouldForceFallback(): boolean {
  return process.env['BRAINSTRIKE_AGENT_TEST_MODE'] === '1' || process.env['VITEST'] === 'true';
}

function loadAgentClient(): AgentClientModule | null {
  if (cachedAgentClient !== undefined) {
    return cachedAgentClient;
  }

  if (shouldForceFallback()) {
    cachedAgentClient = null;
    return cachedAgentClient;
  }

  const fromExports = tryRequireAgentClient('@brainstrike/agent/client');
  if (fromExports) {
    cachedAgentClient = fromExports;
    return cachedAgentClient;
  }

  const packageRoot = resolveAgentPackageRoot();
  if (packageRoot) {
    const distPath = path.join(packageRoot, 'dist/client.js');
    const resolved = tryRequireAbsolute(distPath);
    if (resolved) {
      cachedAgentClient = resolved;
      return cachedAgentClient;
    }
  }

  const workspaceFallback = resolveWorkspaceDist();
  if (workspaceFallback) {
    const resolved = tryRequireAbsolute(workspaceFallback);
    if (resolved) {
      cachedAgentClient = resolved;
      return cachedAgentClient;
    }
  }

  cachedAgentClient = null;

  if (!(cachedAgentClient || fallbackNotified)) {
    fallbackNotified = true;
    logger.warn(
      'Falling back to static provider metadata. Run "pnpm --filter @brainstrike/agent build" to restore @brainstrike/agent/client outputs.'
    );
  }

  return cachedAgentClient;
}

function tryRequireAbsolute(targetPath: string): AgentClientModule | null {
  try {
    if (!existsSync(targetPath)) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(targetPath) as AgentClientModule;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string };
    if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')) {
      return null;
    }
    throw error;
  }
}

function resolveAgentPackageRoot(): string | null {
  try {
    const pkgPath = require.resolve('@brainstrike/agent/package.json');
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

function resolveWorkspaceDist(): string | null {
  const candidateRoots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
  ];

  for (const root of candidateRoots) {
    const candidate = path.resolve(root, 'packages/agent/dist/client.js');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function listAgentProviders(): readonly SupportedProvider[] {
  const module = loadAgentClient();
  if (module) {
    return module
      .listProviders()
      .map((provider: ProviderDefinition) => provider.id as SupportedProvider);
  }
  return FALLBACK_PROVIDERS;
}

export function getAgentProviderEnvKeys(provider: SupportedProvider): readonly string[] {
  const module = loadAgentClient();
  if (module) {
    return module.providerEnvKeys(provider);
  }
  return FALLBACK_ENV_KEYS[provider] ?? [];
}

export function clearCachedAgentClient() {
  cachedAgentClient = undefined;
  fallbackNotified = false;
}
