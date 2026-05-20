import { isSupportedProvider } from '@brainstrike/agent';
import type { SupportedProvider } from '@brainstrike/agent/client';
import { createLogger } from '@brainstrike/utils/logger';
import { ipcMain } from 'electron';
import type { McpConfig } from './mcp-loader';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import { readProviderSecretKey, resolveProviderEnvKey } from './provider-api-key';

// Minimal local types to avoid cross-project TS coupling during type-check
interface AgentMessage {
  id: string;
  parts: Array<{ type: 'text'; text: string }>;
  role: 'user' | 'assistant' | 'system';
}
interface RuntimeData {
  mcpConfig?: McpConfig;
  mcpEnabled?: boolean;
  model?: string;
  projectId?: string;
  provider?: string;
}
type StreamChunk =
  | { type: 'reasoning-delta'; value: string }
  | {
      type: 'run-event';
      event: unknown;
    }
  | { type: 'text-delta'; value: string }
  | {
      type: 'tool-event';
      name: string;
      status: 'start' | 'progress' | 'success' | 'error';
      payload?: unknown;
    }
  | {
      type: 'finish';
      usage: { promptTokens: number; completionTokens: number };
    }
  | {
      type: 'message-finish';
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number };
      path: readonly number[];
    };

const logger = createLogger('DesktopIpcAgent');
type AgentModule = typeof import('@brainstrike/agent');
type MaybeAsyncIterable<T> = AsyncIterable<T> | Promise<AsyncIterable<T>>;

export function registerAgentIpcHandlers(): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke(
    'agent',
    'agent:chat',
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
  const agentModule = resolveAgentModule();
  const config = await loadMcpConfig();
  const { mcpConfig: _ignoredMcpConfig, ...runtimeWithoutMcpConfig } = runtime ?? {};
  const provider = resolveAgentProvider(runtime);
  if (!provider) {
    throw new Error('missing_provider');
  }
  const apiKey = await resolveIpcApiKey(provider);
  if (!apiKey) {
    throw new Error(`missing_api_key:${provider}`);
  }

  const maybeStream = agentModule.streamMastraAgent(messages, {
    runtime: {
      ...runtimeWithoutMcpConfig,
      provider,
      apiKey,
      ...(config.config ? { mcpConfig: config.config } : {}),
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

  const envKey = resolveProviderEnvKey(supportedProvider);
  if (envKey) {
    logger.info('Using environment API key for provider', { provider });
    return envKey;
  }

  const storedKey = await readProviderSecretKey(supportedProvider);
  if (storedKey) {
    logger.info('Retrieved stored API key for provider', {
      provider,
      prefix: storedKey.slice(0, 10),
    });
    return storedKey;
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
