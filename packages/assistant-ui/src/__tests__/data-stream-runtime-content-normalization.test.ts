// @vitest-environment node
import type { ThreadMessage } from '@assistant-ui/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const genericMessages = vi.hoisted(() => ({
  value: [] as Array<{
    readonly content?: unknown;
    readonly role: 'assistant' | 'system' | 'tool' | 'user';
  }>,
}));

vi.mock('assistant-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('assistant-stream')>();
  return {
    ...actual,
    toGenericMessages: vi.fn(() => genericMessages.value),
  };
});

import { BrainstrikeDataStreamRuntimeAdapter } from '../data-stream-runtime';

function message(id: string, role: ThreadMessage['role']): ThreadMessage {
  return {
    content: [{ text: id, type: 'text' }],
    createdAt: new Date(0),
    id,
    metadata: { custom: {} },
    role,
  } as ThreadMessage;
}

function dataStreamFromLines(lines: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

function runOptions(
  overrides: Partial<Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0]> = {}
): Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0] {
  return {
    abortSignal: new AbortController().signal,
    context: {
      callSettings: {},
      config: {},
      tools: {},
    },
    messages: [message('user', 'user')],
    runConfig: undefined,
    unstable_getMessage: () => message('message-id', 'assistant'),
    ...overrides,
  } as Parameters<BrainstrikeDataStreamRuntimeAdapter['run']>[0];
}

describe('BrainstrikeDataStreamRuntimeAdapter content normalization', () => {
  afterEach(() => {
    genericMessages.value = [];
    vi.unstubAllGlobals();
  });

  it('normalizes non-array hosted message content before serialization', async () => {
    genericMessages.value = [
      {
        content: undefined,
        role: 'system',
      },
      {
        content: 'plain prompt',
        role: 'user',
      },
      {
        content: {
          args: { query: 'status' },
          toolCallId: 'call-object',
          toolName: 'lookup',
          type: 'tool-call',
        },
        role: 'assistant',
      },
    ];

    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          dataStreamFromLines([
            'f:{"messageId":"msg-test"}',
            '0:"Done"',
            'd:{"finishReason":"stop","usage":{"inputTokens":1,"outputTokens":1},"path":[]}',
          ])
        );
      })
    );

    const adapter = new BrainstrikeDataStreamRuntimeAdapter({
      api: 'http://assistant.test/api/assistant',
    });

    for await (const _message of adapter.run(runOptions())) {
      // Consume the response so the request is fully exercised.
    }

    expect(requestBody?.['messages']).toEqual([
      {
        content: [],
        role: 'system',
      },
      {
        content: [{ text: 'plain prompt' }],
        id: 'user',
        role: 'user',
      },
      {
        content: [
          {
            input: { query: 'status' },
            toolCallId: 'call-object',
            toolName: 'lookup',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
    ]);
  });
});
