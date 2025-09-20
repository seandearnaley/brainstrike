import {
  clearToolRegistry,
  completeToolCall,
  createToolRegistry,
  recordToolProgress,
  startToolCall,
} from '@brainstrike/agent';
import type { ToolCallStreamController } from 'assistant-stream';

export interface StreamChunk {
  type: 'text-delta' | 'tool-event' | 'finish' | 'message-finish';
  value?: string;
  name?: string;
  status?: string;
  payload?: unknown;
  usage?: { promptTokens?: number; completionTokens?: number };
  finishReason?: string;
  path?: ReadonlyArray<number>;
}

export interface StreamController {
  addTextPart: () => void;
  appendText: (text: string) => void;
  addToolCallPart: (options: { toolName: string }) => ToolCallStreamController;
  close: () => void;
  enqueue: (chunk: {
    type: 'message-finish';
    finishReason: 'stop';
    usage: { promptTokens: number; completionTokens: number };
    path: ReadonlyArray<number>;
  }) => void;
}

export type ToolControllerEntry = {
  controller: ToolCallStreamController;
  name: string;
};

export type AssistantToolRegistry = {
  byKey: Map<string, ToolControllerEntry>;
  nameToKeys: Map<string, string[]>;
};

export const createAssistantToolRegistry =
  createToolRegistry as unknown as () => AssistantToolRegistry;
export const startToolProxy = startToolCall as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  payload: unknown,
  controller: ToolCallStreamController
) => void;
export const recordToolProgressProxy = recordToolProgress as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  payload: unknown
) => string | undefined;
export const completeToolProxy = completeToolCall as unknown as (
  registry: AssistantToolRegistry,
  name: string,
  status: string,
  payload: unknown
) => void;
export const clearToolProxy = clearToolRegistry as unknown as (
  registry: AssistantToolRegistry
) => void;

export function handleTextDelta(
  ctrl: StreamController,
  value?: string,
  startedParam?: boolean
): boolean {
  let started = startedParam;
  if (!started) {
    ctrl.addTextPart();
    started = true;
  }
  if (value) ctrl.appendText(value);
  return started;
}

export function handleToolEvent(
  ctrl: StreamController,
  registry: AssistantToolRegistry,
  chunk: StreamChunk
): string | undefined {
  const { name, status, payload } = chunk;
  if (!name || !status) return undefined;
  if (status === 'start') {
    const controller = ctrl.addToolCallPart({ toolName: name });
    startToolProxy(registry, name, payload, controller);
  } else if (status === 'progress') {
    return recordToolProgressProxy(registry, name, payload);
  } else if (status === 'success' || status === 'error') {
    completeToolProxy(registry, name, status, payload);
  }
  return undefined;
}

export function toMessageFinishChunk(chunk: StreamChunk): {
  type: 'message-finish';
  finishReason: 'stop';
  usage: { promptTokens: number; completionTokens: number };
  path: ReadonlyArray<number>;
} {
  const usage = chunk.usage ?? { promptTokens: 0, completionTokens: 0 };
  const promptTokensRaw = usage.promptTokens;
  const completionTokensRaw = usage.completionTokens;
  const promptTokens =
    typeof promptTokensRaw === 'number' && Number.isFinite(promptTokensRaw) ? promptTokensRaw : 0;
  const completionTokens =
    typeof completionTokensRaw === 'number' && Number.isFinite(completionTokensRaw)
      ? completionTokensRaw
      : 0;
  return {
    type: 'message-finish',
    finishReason: 'stop',
    usage: { promptTokens, completionTokens },
    path: Array.isArray(chunk.path) ? chunk.path : [],
  };
}

type DesktopChunkResult = { started: boolean; finished: boolean };

export function processDesktopChunk(
  ctrl: StreamController,
  tools: AssistantToolRegistry,
  chunk: StreamChunk,
  started: boolean,
  setStarted: (v: boolean) => void
): DesktopChunkResult {
  if (chunk.type === 'finish' || chunk.type === 'message-finish') {
    ctrl.enqueue(toMessageFinishChunk(chunk));
    setStarted(false);
    return { started, finished: true };
  }
  if (chunk.type === 'text-delta') {
    const nextStarted = handleTextDelta(ctrl, chunk.value, started);
    setStarted(nextStarted);
    return { started: nextStarted, finished: false };
  }
  if (chunk.type === 'tool-event') {
    const progressText = handleToolEvent(ctrl, tools, chunk);
    const nextStarted = progressText ? handleTextDelta(ctrl, `${progressText}\n`, false) : started;
    setStarted(nextStarted);
    return { started: nextStarted, finished: false };
  }
  return { started, finished: false };
}

export async function iterateAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>,
  tools: AssistantToolRegistry,
  isAborted: () => boolean,
  setStarted: (started: boolean) => void,
  startedInitial: boolean
): Promise<void> {
  let started = startedInitial;
  for await (const chunk of agentStream) {
    if (chunk.type === 'tool-event' && !started && chunk.status === 'start') {
      ctrl.addTextPart();
      started = true;
      setStarted(true);
    }
    if (isAborted()) break;
    const result = processDesktopChunk(ctrl, tools, chunk, started, setStarted);
    started = result.started;
    if (result.finished) break;
  }
}

export async function processAgentStream(
  ctrl: StreamController,
  agentStream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal | null,
  preStarted?: boolean
): Promise<void> {
  let started = Boolean(preStarted);
  const tools = createAssistantToolRegistry();
  let aborted = Boolean(signal?.aborted);
  const onAbort = () => {
    aborted = true;
  };
  try {
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    await iterateAgentStream(
      ctrl,
      agentStream,
      tools,
      () => aborted,
      (v) => {
        started = v;
      },
      started
    );
  } catch (err) {
    if (!(aborted && err instanceof Error)) {
      // swallow provider errors on abort
    }
  } finally {
    for (const entry of tools.byKey.values()) {
      try {
        entry.controller.close();
      } catch {}
    }
    try {
      clearToolProxy(tools);
    } catch {}
    try {
      ctrl.close();
    } catch {}
    if (signal) signal.removeEventListener?.('abort', onAbort as EventListener);
  }
}
