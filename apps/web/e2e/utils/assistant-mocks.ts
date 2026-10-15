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
        if (url.includes('/api/assistant') && !url.includes('/api/assistant/status')) {
          return createMockResponse(init?.signal ?? undefined);
        }
        return originalFetch(input, init);
      };
    },
    { chunks: buildChunks(), status: statusPayload }
  );
}

/**
 * The hosted-provider availability payload the assistant status endpoint
 * answers with, so the composer resolves a provider and model without a real
 * server key. Mirrors the shape `assistant-panel.test.ts` already relies on.
 */
export const HOSTED_ASSISTANT_STATUS: Record<string, unknown> = {
  enabled: true,
  model: 'gpt-5.6-terra',
  provider: 'openai',
  providerKeySources: [{ envVar: 'OPENAI_API_KEY', provider: 'openai', source: 'env' }],
  providers: ['openai'],
};

/** The final assistant text every held turn streams once the test releases it. */
export const GATED_RUN_RESPONSE = 'Assistant: Gated response released.';

/** One held `/api/assistant` turn, controllable from the test. */
interface GatedRunControls {
  /** Stream the release text and the finish chunk, then close the stream. */
  readonly finish: (text: string) => void;
  /** Append a text delta without ending the turn. */
  readonly pushText: (text: string) => void;
  readonly runId: string;
}

/** The held-run ledger `mockGatedAssistantApi` exposes as `window.__assistantGatedRuns`. */
interface GatedRunLedger {
  /** Raw request bodies, in start order, parsed Node-side by `readGatedRunPrompts`. */
  readonly bodies: string[];
  readonly cancelled: string[];
  readonly controls: GatedRunControls[];
  started: number;
}

/**
 * A gated hosted-stream mock: every `/api/assistant` turn opens its data
 * stream and then HOLDS, so tab switches, closes and Stop all land mid-run
 * deterministically. The ledger counts started runs, keeps each request body,
 * and records an abort the moment the transport's `AbortSignal` fires — which
 * is exactly how a real Stop detaches a hosted request.
 *
 * Pair with `openAssistantWorkspace(page, { hostedAssistantModel: true })`.
 */
export async function mockGatedAssistantApi(
  page: Page,
  statusPayload: Record<string, unknown> = HOSTED_ASSISTANT_STATUS
): Promise<void> {
  await page.addInitScript(
    ({ status }) => {
      const encoder = new TextEncoder();
      const originalFetch = window.fetch.bind(window);
      const ledger: GatedRunLedger = { bodies: [], cancelled: [], controls: [], started: 0 };
      Object.defineProperty(window, '__assistantGatedRuns', { configurable: true, value: ledger });

      function createHeldResponse(runId: string, signal: AbortSignal | undefined): Response {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        let aborted = false;

        const recordAbort = (): void => {
          if (aborted) {
            return;
          }
          aborted = true;
          ledger.cancelled.push(runId);
          controller?.error(new DOMException('Aborted', 'AbortError'));
          controller = null;
        };

        const send = (type: string, value: unknown): void => {
          if (!controller) {
            throw new Error(`Gated run ${runId} is no longer streaming`);
          }
          controller.enqueue(encoder.encode(`${type}:${JSON.stringify(value)}\n`));
        };

        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            recordAbort();
          },
          start(streamController) {
            controller = streamController;
          },
        });

        ledger.controls.push({
          finish(text: string) {
            if (!controller) {
              return;
            }
            send('0', text);
            send('d', {
              finishReason: 'stop',
              path: [],
              usage: { inputTokens: 12, outputTokens: 24 },
            });
            controller.close();
            controller = null;
          },
          pushText(text: string) {
            send('0', text);
          },
          runId,
        });

        if (signal) {
          if (signal.aborted) {
            recordAbort();
          } else {
            signal.addEventListener('abort', recordAbort, { once: true });
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
        if (url.includes('/api/assistant')) {
          const runId = `gated-run-${ledger.started}`;
          ledger.started += 1;
          ledger.bodies.push(typeof init?.body === 'string' ? init.body : '');
          return createHeldResponse(runId, init?.signal ?? undefined);
        }
        return originalFetch(input, init);
      };
    },
    { status: statusPayload }
  );
}

// page.evaluate bodies are serialized, so each reads the ledger inline.
export async function readGatedRuns(
  page: Page
): Promise<{ readonly cancelled: readonly string[]; readonly started: number }> {
  return await page.evaluate(() => {
    const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
      .__assistantGatedRuns;
    if (!ledger) {
      throw new Error('Expected mockGatedAssistantApi to install the gated-run ledger');
    }
    return { cancelled: [...ledger.cancelled], started: ledger.started };
  });
}

/** Finish every still-open held run with `GATED_RUN_RESPONSE`. */
export async function releaseGatedRuns(page: Page): Promise<void> {
  await page.evaluate((releasedText: string) => {
    const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
      .__assistantGatedRuns;
    if (!ledger) {
      throw new Error('Expected mockGatedAssistantApi to install the gated-run ledger');
    }
    for (const control of ledger.controls) {
      control.finish(releasedText);
    }
  }, GATED_RUN_RESPONSE);
}

/** Append a text delta to a held run without ending its turn. */
export async function streamGatedRunText(
  page: Page,
  runIndex: number,
  text: string
): Promise<void> {
  await page.evaluate(
    ({ index, value }) => {
      const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
        .__assistantGatedRuns;
      if (!ledger) {
        throw new Error('Expected mockGatedAssistantApi to install the gated-run ledger');
      }
      const control = ledger.controls[index];
      if (!control) {
        throw new Error(`No gated run at index ${index}`);
      }
      control.pushText(value);
    },
    { index: runIndex, value: text }
  );
}

/** Finish one held run with its own final text. */
export async function finishGatedRun(page: Page, runIndex: number, text: string): Promise<void> {
  await page.evaluate(
    ({ index, value }) => {
      const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
        .__assistantGatedRuns;
      if (!ledger) {
        throw new Error('Expected mockGatedAssistantApi to install the gated-run ledger');
      }
      const control = ledger.controls[index];
      if (!control) {
        throw new Error(`No gated run at index ${index}`);
      }
      control.finish(value);
    },
    { index: runIndex, value: text }
  );
}

/** Every held run's latest user prompt, read back off the wire in start order. */
export async function readGatedRunPrompts(page: Page): Promise<readonly string[]> {
  const bodies = await page.evaluate(() => {
    const ledger = (window as unknown as { __assistantGatedRuns?: GatedRunLedger })
      .__assistantGatedRuns;
    if (!ledger) {
      throw new Error('Expected mockGatedAssistantApi to install the gated-run ledger');
    }
    return [...ledger.bodies];
  });
  return bodies.map((body, index) => extractLatestUserText(body, index));
}

interface WireMessagePart {
  readonly text?: unknown;
  readonly type?: unknown;
}

interface WireMessage {
  readonly content?: unknown;
  readonly parts?: readonly WireMessagePart[];
  readonly role?: unknown;
}

/**
 * The prompt a request carried, read from the body the transport posted.
 * Throws rather than returning a placeholder: an unreadable body means the
 * wire shape changed, which the suite must surface, not absorb.
 */
function extractLatestUserText(body: string, index: number): string {
  const parsed: unknown = JSON.parse(body);
  const messages = (parsed as { readonly messages?: readonly WireMessage[] }).messages;
  if (!Array.isArray(messages)) {
    throw new Error(`Gated run ${index} posted a body without a messages array`);
  }
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  if (!latestUser) {
    throw new Error(`Gated run ${index} posted no user message`);
  }
  if (typeof latestUser.content === 'string') {
    return latestUser.content;
  }
  const parts = latestUser.parts;
  if (parts) {
    let text = '';
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
    if (text) {
      return text;
    }
  }
  throw new Error(`Gated run ${index} posted a user message with no readable text`);
}
