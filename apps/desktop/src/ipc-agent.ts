import {
  type AgentMessage,
  isSupportedProvider,
  type RuntimeData,
  type StreamChunk,
} from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/logging';
import { ipcMain } from 'electron';
import { readOpenAIApiKey } from './openai-api-key';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { readProviderCredential } from './provider-api-key';
import { SecretReadError } from './secrets';

const UNAUTHENTICATED_SENDER_POLICY = {
  reason:
    'Exposed only by the visible-UI preload (dist/preload.js); sender-role policy pending (BST-1641 follow-up).',
} as const;

const logger = createLogger('DesktopIpcAgent');
type AgentModule = typeof import('@brainstrike/agent');
type MaybeAsyncIterable<T> = AsyncIterable<T> | Promise<AsyncIterable<T>>;

export function registerAgentIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerUnauthenticatedInvoke(
    'agent',
    DESKTOP_PRELOAD_IPC_CHANNELS.agent.chat,
    UNAUTHENTICATED_SENDER_POLICY,
    async (_event, messages: AgentMessage[], runtime?: RuntimeData): Promise<StreamChunk[]> =>
      runAgentChat(messages, runtime)
  );

  return () => {
    registry.unregisterAll();
  };
}

async function runAgentChat(
  messages: AgentMessage[],
  runtime: RuntimeData | undefined
): Promise<StreamChunk[]> {
  const provider = resolveAgentProvider(runtime);
  if (!provider) {
    throw new Error('missing_provider');
  }
  const apiKey = await resolveIpcApiKey(provider);
  if (!apiKey) {
    throw new Error(`missing_api_key:${provider}`);
  }

  const agentModule = resolveAgentModule();
  const { mcpConfig: _ignoredMcpConfig, ...runtimeWithoutMcpConfig } = runtime ?? {};

  // Legacy chat carries no MCP (BST-1930): the one MCP runtime serves agent-host threads.
  const maybeStream = agentModule.streamMastraAgent(messages, {
    runtime: {
      ...runtimeWithoutMcpConfig,
      apiKey,
      provider,
    },
  });

  const stream = await ensureAsyncIterable<StreamChunk>(maybeStream);
  return collectStreamChunks(stream);
}

function resolveAgentModule(): AgentModule {
  const injected = (globalThis as { __agentModule?: AgentModule }).__agentModule;
  if (injected) {
    return injected;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@brainstrike/agent') as AgentModule;
}

function resolveAgentProvider(runtime: RuntimeData | undefined): string | undefined {
  const raw = typeof runtime?.provider === 'string' ? runtime.provider.trim() : '';
  if (!raw) {
    return;
  }
  const normalized = raw.toLowerCase();
  return isSupportedProvider(normalized) ? normalized : undefined;
}

async function resolveIpcApiKey(provider: string): Promise<string | undefined> {
  if (!isSupportedProvider(provider)) {
    return;
  }
  const supportedProvider = provider as SupportedProvider;

  // BST-1352 review finding 10: ride the ONE shared env-authoritative core
  // (readProviderCredential → resolveHostedProviderCredential) instead of a
  // hand-rolled env → stored sequence. A stored non-api_key credential
  // degrades exactly like the old string read: the classified
  // credential_type_unsupported SecretReadError, never a stringified
  // credential or a silent "not configured".
  const credential = await readProviderCredential(supportedProvider);
  if (credential) {
    if (credential.type !== 'api_key') {
      throw new SecretReadError('credential_type_unsupported', provider);
    }
    if (credential.source === 'env') {
      logger.info('Using environment API key for provider', { provider });
    } else {
      logger.info('Retrieved stored API key for provider', {
        prefix: credential.key.slice(0, 10),
        provider,
      });
    }
    return credential.key;
  }

  if (provider === 'openai') {
    const fallback = await readOpenAIApiKey();
    if (fallback) {
      logger.info('Using fallback OpenAI key', { prefix: fallback.slice(0, 10) });
    }
    return fallback ?? undefined;
  }
  return;
}

async function ensureAsyncIterable<T>(
  maybeIterable: MaybeAsyncIterable<T>
): Promise<AsyncIterable<T>> {
  if (isAsyncIterable(maybeIterable)) {
    return maybeIterable;
  }
  return await maybeIterable;
}

async function collectStreamChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  if (!value) {
    return false;
  }
  const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof asyncIterator === 'function';
}
