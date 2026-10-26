/**
 * The model-provider shim's OpenAI embeddings wire (`POST /embeddings` through
 * `OPENAI_BASE_URL`), served only when a spec opts in with the model's
 * dimensions. Each character trigram of a text's lowercased words has one fixed
 * pseudo-random direction, and a text embeds as the normalized sum of its
 * trigrams' directions: the same text embeds the same on every request, so a
 * recalled message is the nearest match to its own text, and texts that share
 * spelling lie close, so a misspelled query that shares no word with a file
 * still ranks it by its vectors alone.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from 'node:stream/consumers';

/** One served embeddings request: the model and the texts it embedded. */
export interface ModelProviderEmbeddingRequest {
  readonly input: readonly string[];
  readonly model: string;
}

/** The text's character trigrams, word by word; a word of three or fewer characters is one. */
function trigrams(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const grams = words.flatMap((word) =>
    word.length <= 3
      ? [word]
      : Array.from({ length: word.length - 2 }, (_, start) => word.slice(start, start + 3))
  );
  return grams.length > 0 ? grams : [text];
}

/** `text` as the shim embeds it, so a spec can embed a query exactly as its documents were. */
export function embedText(text: string, dimensions: number): number[] {
  const counts = new Map<string, number>();
  for (const gram of trigrams(text)) {
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  const sum = new Array<number>(dimensions).fill(0);
  for (const [gram, count] of counts) {
    // mulberry32, seeded from the trigram's hash: one fixed direction per trigram.
    let state = createHash('sha256').update(gram).digest().readUInt32LE(0);
    for (let index = 0; index < dimensions; index += 1) {
      state = (state + 0x6d_2b_79_f5) >>> 0;
      let mixed = Math.imul(state ^ (state >>> 15), state | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      const component = ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296 - 0.5;
      sum[index] = (sum[index] ?? 0) + count * component;
    }
  }
  const norm = Math.hypot(...sum);
  return sum.map((value) => value / norm);
}

/** Answers one embeddings request as OpenAI does; a malformed body throws. */
async function answerEmbeddings(
  request: IncomingMessage,
  response: ServerResponse,
  dimensions: number
): Promise<ModelProviderEmbeddingRequest> {
  const body: unknown = await json(request);
  if (!(body && typeof body === 'object' && 'input' in body && 'model' in body)) {
    throw new Error('Model provider shim expected an embeddings body with model and input.');
  }
  const { input, model } = body;
  const texts = typeof input === 'string' ? [input] : input;
  if (
    typeof model !== 'string' ||
    !Array.isArray(texts) ||
    !texts.every((text): text is string => typeof text === 'string')
  ) {
    throw new Error('Model provider shim expected string embeddings input.');
  }
  const tokens = texts.reduce((total, text) => total + text.split(/\s+/u).length, 0);
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(
    JSON.stringify({
      data: texts.map((text, index) => ({
        embedding: embedText(text, dimensions),
        index,
        object: 'embedding',
      })),
      model,
      object: 'list',
      usage: { ['prompt_tokens']: tokens, ['total_tokens']: tokens },
    })
  );
  return { input: texts, model };
}

/**
 * Serves `POST /embeddings` through `OPENAI_BASE_URL` once a spec opted in with
 * `dimensions`, recording it in `served`; false for any other request.
 */
export function serveEmbeddingsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  path: { readonly knob: string | null; readonly route: string },
  dimensions: number | undefined,
  served: ModelProviderEmbeddingRequest[]
): boolean {
  if (
    dimensions === undefined ||
    request.method !== 'POST' ||
    path.knob !== 'OPENAI_BASE_URL' ||
    path.route !== '/embeddings'
  ) {
    return false;
  }
  void answerEmbeddings(request, response, dimensions).then(
    (embedded) => served.push(embedded),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
    }
  );
  return true;
}
