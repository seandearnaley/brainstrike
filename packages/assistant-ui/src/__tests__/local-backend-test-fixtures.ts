import type { ChatModelRunOptions, ChatModelRunResult } from '@assistant-ui/react';
import type { LocalLlmBackend, LocalLlmGenerationResult } from '@brainstrike/assistant-contract';
import { expect, vi } from 'vitest';

export const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets every already-queued microtask chain (and one timer turn) settle. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function generationResult(text: string): LocalLlmGenerationResult {
  return {
    finishReason: 'stop',
    text,
    usage: { completionTokens: 1, promptTokens: 1, totalTokens: 2 },
  };
}

export function createRunOptions(): ChatModelRunOptions {
  return {
    abortSignal: new AbortController().signal,
    context: {},
    messages: [
      {
        attachments: [],
        content: [{ text: 'Tell me a joke', type: 'text' }],
        createdAt: new Date('2026-04-10T00:00:00.000Z'),
        id: 'user-1',
        metadata: { custom: {} },
        role: 'user',
      },
    ],
    runConfig: {},
    unstable_getMessage() {
      throw new Error('not needed in local adapter tests');
    },
  };
}

export async function collectRun(
  runResult: Promise<ChatModelRunResult> | AsyncGenerator<ChatModelRunResult, void>
): Promise<ChatModelRunResult[]> {
  if (!(Symbol.asyncIterator in runResult)) {
    return [await runResult];
  }
  const updates: ChatModelRunResult[] = [];
  for await (const update of runResult) {
    updates.push(update);
  }
  return updates;
}

export function finalText(updates: readonly ChatModelRunResult[]): string {
  const parts = updates.at(-1)?.content ?? [];
  return parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/**
 * Backends with the runtime shape of `LocalLlmBackend` (packages/agent
 * local-llm-backend.ts): `generate` throws until `initialize` has run, `dispose`
 * drops the engine so `isReady()` turns false, and every `loadBackend()` call
 * constructs a fresh instance, exactly as the web loader does. The gates hold
 * the matching step open until the test releases it.
 */
export function createLoader(
  gates: { dispose?: Deferred<void>; initialize?: Deferred<void>; load?: Deferred<void> } = {}
) {
  const instances: LocalLlmBackend[] = [];
  // Every `generate` call of every instance, in call order.
  const generations: Deferred<LocalLlmGenerationResult>[] = [];
  const loadBackend = vi.fn(async (): Promise<LocalLlmBackend> => {
    await gates.load?.promise;
    let ready = false;
    const backend: LocalLlmBackend = {
      dispose: vi.fn(async () => {
        await gates.dispose?.promise;
        ready = false;
      }),
      generate: vi.fn(async () => {
        if (!ready) {
          throw new Error('Model not initialized. Call initialize() first.');
        }
        const generation = deferred<LocalLlmGenerationResult>();
        generations.push(generation);
        return generation.promise;
      }),
      initialize: vi.fn(async () => {
        await gates.initialize?.promise;
        ready = true;
      }),
      isReady: vi.fn(() => ready),
    };
    instances.push(backend);
    return backend;
  });
  return { generations, instances, loadBackend };
}

export async function nextGeneration(
  generations: readonly Deferred<LocalLlmGenerationResult>[],
  index: number
): Promise<Deferred<LocalLlmGenerationResult>> {
  await vi.waitFor(() => expect(generations.length).toBeGreaterThan(index));
  const generation = generations[index];
  if (!generation) {
    throw new Error(`generation ${index} was never requested`);
  }
  return generation;
}
