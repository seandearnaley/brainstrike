import type { Page } from '@playwright/test';

interface Chunk {
  delayMs: number;
  type: string;
  value: unknown;
}

function buildChunks(): Chunk[] {
  return [
    {
      delayMs: 150,
      type: 'b',
      value: { toolCallId: 'mock-call', toolName: 'web.echo' },
    },
    {
      delayMs: 250,
      type: 'c',
      value: { argsTextDelta: 'starting\n', toolCallId: 'mock-call' },
    },
    { delayMs: 200, type: '0', value: 'starting' },
    {
      delayMs: 300,
      type: 'c',
      value: { argsTextDelta: 'echoing\n', toolCallId: 'mock-call' },
    },
    { delayMs: 200, type: '0', value: 'echoing' },
    {
      delayMs: 300,
      type: 'c',
      value: { argsTextDelta: 'finishing\n', toolCallId: 'mock-call' },
    },
    { delayMs: 200, type: '0', value: 'finishing' },
    {
      delayMs: 250,
      type: 'a',
      value: {
        result: { text: 'echo hello from mock' },
        toolCallId: 'mock-call',
      },
    },
    {
      delayMs: 250,
      type: '0',
      value: 'Assistant: Mock response from tests.',
    },
    {
      delayMs: 100,
      type: 'd',
      value: { finishReason: 'stop', path: [], usage: { inputTokens: 12, outputTokens: 24 } },
    },
  ];
}

export async function mockAssistantApi(
  page: Page,
  statusPayload: Record<string, unknown> = { enabled: true }
): Promise<void> {
  await page.addInitScript(
    ({ chunks, status }) => {
      if ((window as unknown as { __assistantMockApplied?: boolean }).__assistantMockApplied) {
        return;
      }
      (window as unknown as { __assistantMockApplied?: boolean }).__assistantMockApplied = true;

      const encoder = new TextEncoder();
      const originalFetch = window.fetch.bind(window);

      function createMockResponse(signal: AbortSignal | undefined) {
        const chunkData = chunks.map((chunk: Chunk) => ({ ...chunk }));
        let index = 0;
        let aborted = false;

        const handleAbort = (controller: ReadableStreamDefaultController<Uint8Array>) => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        };

        const processNextChunk = async (
          controller: ReadableStreamDefaultController<Uint8Array>
        ) => {
          const entry = chunkData[index++];
          if (!entry) {
            return;
          }
          if (entry.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
          }
          if (aborted) {
            return handleAbort(controller);
          }
          const payload = `${entry.type}:${JSON.stringify(entry.value)}\n`;
          controller.enqueue(encoder.encode(payload));
        };

        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            aborted = true;
          },
          async pull(controller) {
            if (aborted) {
              return handleAbort(controller);
            }
            if (index >= chunkData.length) {
              return controller.close();
            }
            await processNextChunk(controller);
          },
        });

        if (signal) {
          const onAbort = () => {
            aborted = true;
          };
          if (signal.aborted) {
            aborted = true;
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        return new Response(stream, {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'text/plain; charset=utf-8',
            'x-vercel-ai-data-stream': 'v1',
          },
          status: 200,
        });
      }

      window.fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
        if (url.includes('/api/assistant/status')) {
          return new Response(JSON.stringify(status), {
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json',
            },
            status: 200,
          });
        }
        if (
          (url.includes('/api/assistant') && !url.includes('/api/assistant/status')) ||
          url.includes('/api/chat')
        ) {
          return createMockResponse(init?.signal ?? undefined);
        }
        return originalFetch(input, init);
      };
    },
    { chunks: buildChunks(), status: statusPayload }
  );
}

/** The held-run ledger `mockGatedLocalLlmHost` exposes as `window.__assistantGatedRuns`. */
interface GatedRunLedger {
  readonly cancelledRequestIds: string[];
  readonly releases: Array<() => void>;
  started: number;
}

interface GatedHostProgressEvent {
  readonly payload: Record<string, unknown>;
  readonly requestId: string;
  readonly type: 'progress';
}

export const GATED_RUN_RESPONSE = 'Assistant: Gated response released.';

/**
 * A mocked browser-local model host (`window.llmHost`) whose every turn HOLDS
 * until the test calls `releaseGatedRuns`, so tab switches and closes land
 * deterministically mid-run. `cancel` records each host abort the local runtime
 * issues and, like the real bridge, rejects THAT request's held `generate` with
 * the plain Error an abort becomes after crossing Electron IPC (message only,
 * `name` 'Error'). Pair with
 * `openAssistantWorkspace(page, { enableLocalAssistantModel: true })`.
 */
export async function mockGatedLocalLlmHost(page: Page): Promise<void> {
  await page.addInitScript((responseText: string) => {
    window.__assistantAvailabilityOverride = { state: 'enabled' };
    const ledger: GatedRunLedger = { cancelledRequestIds: [], releases: [], started: 0 };
    Object.defineProperty(window, '__assistantGatedRuns', { configurable: true, value: ledger });
    const progressListeners = new Set<(event: GatedHostProgressEvent) => void>();
    const emit = (requestId: string, payload: Record<string, unknown>): void => {
      for (const listener of progressListeners) {
        listener({
          payload: { clientRequestId: requestId, ...payload },
          requestId,
          type: 'progress',
        });
      }
    };

    const heldRejecters = new Map<string, (reason: Error) => void>();

    // @ts-expect-error local runtime host mock for e2e
    window.llmHost = {
      async cancel(requestId: string) {
        ledger.cancelledRequestIds.push(requestId);
        heldRejecters.get(requestId)?.(
          new Error(
            "Error invoking remote method 'llm-host:generate': Error: The operation was aborted."
          )
        );
        heldRejecters.delete(requestId);
      },
      async generate({ requestId }: { readonly requestId: string }) {
        emit(requestId, { kind: 'stage', message: 'responding' });
        ledger.started += 1;
        await new Promise<void>((resolve, reject) => {
          ledger.releases.push(resolve);
          heldRejecters.set(requestId, reject);
        });
        heldRejecters.delete(requestId);
        emit(requestId, { kind: 'text', text: responseText });
        return {
          finishReason: 'stop',
          text: responseText,
          usage: { completionTokens: 8, promptTokens: 12, totalTokens: 20 },
        };
      },
      onProgress(callback: (event: GatedHostProgressEvent) => void) {
        progressListeners.add(callback);
        return () => progressListeners.delete(callback);
      },
      warmup: async () => undefined,
    };
  }, GATED_RUN_RESPONSE);
}

// page.evaluate bodies are serialized, so each reads the ledger inline.
export async function readGatedRuns(
  page: Page
): Promise<{ readonly cancelled: readonly string[]; readonly started: number }> {
  return await page.evaluate(() => {
    const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
      .__assistantGatedRuns;
    if (!ledger) {
      throw new Error('Expected mockGatedLocalLlmHost to install the gated-run ledger');
    }
    return { cancelled: [...ledger.cancelledRequestIds], started: ledger.started };
  });
}

export async function releaseGatedRuns(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
      .__assistantGatedRuns;
    if (!ledger) {
      throw new Error('Expected mockGatedLocalLlmHost to install the gated-run ledger');
    }
    for (const release of ledger.releases.splice(0)) {
      release();
    }
  });
}
