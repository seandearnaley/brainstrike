// The token counter worker (BST-2438). The o200k encoder lives on this thread, so its one-time load and each
// request's count never block the host's event loop. It only counts: it reads and writes nothing.
import { parentPort } from 'node:worker_threads';
import {
  getAccurateTokenCounter,
  getAccurateTokenCountingFailureReason,
  startAccurateTokenCounter,
} from '@brainstrike/tokenization/token-utils-accurate-lite';
import type { TokenCounterReply, TokenCounterRequest } from './token-counter.ts';

const port = parentPort;
if (!port) {
  throw new Error('token-counter-worker must run on a worker thread');
}
const replies = port;
startAccurateTokenCounter();

/** A request without text only asks whether the encoder loaded. */
async function reply({ id, text }: TokenCounterRequest): Promise<TokenCounterReply> {
  const counter = await getAccurateTokenCounter();
  if (!counter) {
    const reason = getAccurateTokenCountingFailureReason();
    return {
      id,
      unavailable: reason
        ? `o200k_base counter unavailable: ${reason}`
        : 'o200k_base counter unavailable',
    };
  }
  if (text === undefined) {
    return { id };
  }
  try {
    return { count: counter(text), id };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause), id };
  }
}

replies.on('message', (request: TokenCounterRequest) => {
  void reply(request).then((answer) => replies.postMessage(answer));
});
