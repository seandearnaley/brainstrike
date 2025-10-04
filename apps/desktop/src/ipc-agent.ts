import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { McpConfig } from './mcp-loader';
import { loadMcpConfig } from './mcp-loader';
import { readOpenAIApiKey } from './openai-api-key';
import { getSecretsService } from './secrets';

// Minimal local types to avoid cross-project TS coupling during type-check
type AgentMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: Array<{ type: 'text'; text: string }>;
};
type RuntimeData = {
  projectId?: string;
  provider?: string;
  model?: string;
  mcpEnabled?: boolean;
  mcpConfig?: McpConfig;
};
type StreamChunk =
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
      finishReason: 'stop';
      usage: { promptTokens: number; completionTokens: number };
      path: ReadonlyArray<number>;
    };
type AgentModule = typeof import('@brainstrike/agent');
type MaybeAsyncIterable<T> = AsyncIterable<T> | Promise<AsyncIterable<T>>;

export function registerAgentIpcHandlers() {
  ipcMain.handle(
    'agent:chat',
    async (
      _e: IpcMainInvokeEvent,
      messages: AgentMessage[],
      runtime?: RuntimeData
    ): Promise<StreamChunk[]> => runAgentChat(messages, runtime)
  );
}

async function runAgentChat(
  messages: AgentMessage[],
  runtime: RuntimeData | undefined
): Promise<StreamChunk[]> {
  const agentModule = resolveAgentModule();
  const config = await loadMcpConfig();
  const provider = inferAgentProvider(runtime);
  const apiKey = await resolveIpcApiKey(provider);

  const maybeStream = agentModule.streamMastraAgent(messages, {
    runtime: {
      ...(runtime ?? {}),
      mcpConfig: config.config,
      ...(apiKey ? { apiKey } : {}),
    },
    tools: agentModule.webTools,
  });

  const stream = await ensureAsyncIterable(maybeStream);
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

function inferAgentProvider(runtime: RuntimeData | undefined): string {
  const provider = runtime?.provider;
  return provider && provider.trim().length > 0 ? provider : 'openai';
}

async function resolveIpcApiKey(provider: string): Promise<string | undefined> {
  try {
    const secretsService = getSecretsService();
    const key = await secretsService.getKey(provider);
    const resolvedKey = key ?? undefined;
    console.log(
      `[ipc-agent] Retrieved API key for provider "${provider}":`,
      resolvedKey ? `${resolvedKey.slice(0, 10)}...` : 'null'
    );
    if (resolvedKey || provider !== 'openai') {
      return resolvedKey;
    }
  } catch (error) {
    console.error(`[ipc-agent] Error getting API key for provider "${provider}":`, error);
    if (provider !== 'openai') {
      return undefined;
    }
  }

  return await readLegacyOpenAiApiKey();
}

async function readLegacyOpenAiApiKey(): Promise<string | undefined> {
  try {
    const key = await readOpenAIApiKey();
    console.log('[ipc-agent] Using legacy OpenAI key:', key ? `${key.slice(0, 10)}...` : 'null');
    return key ?? undefined;
  } catch (error) {
    console.error('[ipc-agent] Error reading legacy OpenAI key:', error);
    return undefined;
  }
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
