/**
 * One recorded web turn's transport (BST-1940): the proxy request for a run's
 * committed context, and the data stream frames its response returns. The
 * proxy returns each stream part and step for the browser to record
 * (ADR-0022, 16 Oct amendments); it keeps no transcript.
 */

import type { hostRunContext } from '@brainstrike/agent-host/run-branch';
import { MODEL_STEP_RECORD_RUN_CONFIG_KEY } from '@brainstrike/assistant-contract/model-step';

/** A message of a run's committed model context, as Core builds it (`hostRunContext`). */
export type WebRunContextMessage = ReturnType<typeof hostRunContext>[number];

export interface WebRunTurnRequest {
  /** The run's `run/start` configuration: the proxy request's runtime data. */
  readonly configuration?: Readonly<Record<string, unknown>> | undefined;
  /** The run's committed context, root first, ending with its user message. */
  readonly messages: readonly WebRunContextMessage[];
  readonly modelId: string;
  readonly signal: AbortSignal;
}

/** Sends one recorded turn; the response body is its data stream. */
export type WebRunTurn = (request: WebRunTurnRequest) => Promise<Response>;

type ProxyPart =
  | { readonly text: string; readonly type: 'text' }
  | { readonly data: string; readonly mediaType: string; readonly type: 'file' };

/**
 * A context message as the proxy reads one (`convertAssistantUiMessages`): its
 * text, and a user message's images. A provider is not sent its earlier
 * reasoning. A web turn has no tools, so any other part is refused.
 */
function proxyMessage(message: WebRunContextMessage, index: number) {
  if (message.role !== 'user' && message.role !== 'assistant') {
    throw new Error(`A web turn cannot send a ${message.role} message`);
  }
  const content = typeof message.content === 'string' ? [message.content] : message.content;
  const parts = content.flatMap((part): ProxyPart[] => {
    if (typeof part === 'string') {
      return [{ text: part, type: 'text' }];
    }
    if (part.type === 'text') {
      return [{ text: part.text, type: 'text' }];
    }
    if (part.type === 'reasoning') {
      return [];
    }
    if (part.type === 'file' && message.role === 'user' && typeof part.data === 'string') {
      return [{ data: part.data, mediaType: part.mediaType, type: 'file' }];
    }
    throw new Error(`A web turn cannot send a ${message.role} message's ${part.type} part`);
  });
  return { id: `m${index}`, parts, role: message.role };
}

/**
 * The Hosted Web proxy's turn at `url`. Hosted Web chooses its models on the
 * server, so `modelId` names the provider whose default model answers.
 */
export function hostedWebRunTurn(url: string, send: typeof fetch = fetch): WebRunTurn {
  return ({ configuration, messages, modelId, signal }) =>
    send(url, {
      body: JSON.stringify({
        data: { ...configuration, provider: modelId },
        messages: messages.map(proxyMessage),
        runConfig: { custom: { [MODEL_STEP_RECORD_RUN_CONFIG_KEY]: true } },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    });
}

export interface DataStreamFrame {
  readonly code: string;
  readonly value: unknown;
}

function frame(line: string): DataStreamFrame {
  const separator = line.indexOf(':');
  if (separator <= 0) {
    throw new Error(`The turn's data stream has a malformed frame: ${line.slice(0, 120)}`);
  }
  return { code: line.slice(0, separator), value: JSON.parse(line.slice(separator + 1)) };
}

/**
 * The `<code>:<json>` frames of a data stream, in order. Unlike the vendor's
 * decoder, a malformed frame fails the read: a recorded run never commits with
 * a part missing.
 */
export async function* dataStreamFrames(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<DataStreamFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          yield frame(line);
        }
      }
    }
    buffered += decoder.decode();
    if (buffered.length > 0) {
      yield frame(buffered);
    }
  } finally {
    // A reader that stops early ends the response, so the proxy's turn ends with it.
    if (!ended) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
