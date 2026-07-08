import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProviderDefinition, SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';

type AgentClientModule = typeof import('@brainstrike/agent/client');

let cachedAgentClient: AgentClientModule | null | undefined;
let fallbackNotified = false;
const logger = createLogger('AgentClientLoader');

const FALLBACK_PROVIDERS: readonly SupportedProvider[] = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'cohere',
  'voyage',
  'local',
  'ollama',
  'lmstudio',
];

const FALLBACK_ENV_KEYS: Record<SupportedProvider, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'AI_ANTHROPIC_API_KEY'],
  cohere: ['COHERE_API_KEY', 'AI_COHERE_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'AI_GOOGLE_API_KEY'],
  lmstudio: [], // Local runtime provider, auto-discovered on localhost
  local: [], // Local provider runs in-browser, no API key needed
  ollama: [], // Local runtime provider, auto-discovered on localhost
  openai: [
    'BRAINSTRIKE_OPENAI_API_KEY',
    'BS_OPENAI_API_KEY',
    'OPENAI_API_KEY',
    'AI_OPENAI_API_KEY',
    'OPENAI_API_KEY_V1',
    'OPENAI_API_KEY_V2',
  ],
  openrouter: ['OPENROUTER_API_KEY', 'AI_OPENROUTER_API_KEY'],
  voyage: ['VOYAGE_API_KEY', 'AI_VOYAGE_API_KEY'],
};

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
