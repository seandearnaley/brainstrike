/**
 * The model-provider shim's OpenAI embeddings wire (`POST /embeddings` through
 * `OPENAI_BASE_URL`), served only when a spec opts in with the model's
 * dimensions. Each input text maps to the same unit vector on every request,
 * so a recalled message is the nearest match to its own text.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json } from 'node:stream/consumers';

/** One served embeddings request: the model and the texts it embedded. */
export interface ModelProviderEmbeddingRequest {
  readonly input: readonly string[];
  readonly model: string;
}

function unitVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block += 1) {
    const digest = createHash('sha256').update(`${block}:${text}`).digest();
    for (const byte of digest) {
      values.push(byte / 255 - 0.5);
    }
  }
  const vector = values.slice(0, dimensions);
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
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
        embedding: unitVector(text, dimensions),
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
