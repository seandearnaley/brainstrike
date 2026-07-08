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

export async function mockAssistantApi(page: Page): Promise<void> {
  await page.addInitScript(
    ({ chunks }) => {
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
          return new Response(JSON.stringify({ enabled: true }), {
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
    { chunks: buildChunks() }
  );
}
