import { env, pipeline } from '@huggingface/transformers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveViteOnnxWasmPaths } from '../src/vite';
import tokenizerJson from './fixtures/minilm-tokenizer.json';

// BST-2003: a pinned load reads every file at its revision, the listing probes included.
// Transformers.js 4.3.0 listed a pinned model's files and probed tokenizer_config.json at
// `main` (huggingface/transformers.js#1751). The probe misses the pinned cache entries, so a
// fully cached pinned model failed to reopen offline with "Failed to fetch". This runs the
// browser bundle the renderer ships, with the embedding worker's exact pipeline options.
const REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
// The config fields Transformers.js reads to list a feature-extraction model's files.
const CONFIG = { architectures: ['BertModel'], model_type: 'bert' };
const TOKENIZER_CONFIG = { model_max_length: 512, tokenizer_class: 'BertTokenizer' };

const defaults = {
  allowLocalModels: env.allowLocalModels,
  allowRemoteModels: env.allowRemoteModels,
  fetch: env.fetch,
  useBrowserCache: env.useBrowserCache,
};
let requested: string[] = [];

function json(body: unknown, init: RequestInit | undefined): Response {
  const text = JSON.stringify(body);
  const range = new Headers(init?.headers).get('Range');
  if (range === 'bytes=0-0') {
    return new Response(text.slice(0, 1), {
      headers: { 'content-range': `bytes 0-0/${text.length}`, 'content-type': 'application/json' },
      status: 206,
    });
  }
  return new Response(text, { headers: { 'content-type': 'application/json' }, status: 200 });
}

// The hub, answered in-process: JSON files at any revision, and no ONNX weights.
async function hub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  requested.push(url);
  const file = new URL(url).pathname.split('/').pop();
  if (file === 'config.json') {
    return json(CONFIG, init);
  }
  if (file === 'tokenizer_config.json') {
    return json(TOKENIZER_CONFIG, init);
  }
  if (file === 'tokenizer.json') {
    return json(tokenizerJson, init);
  }
  return new Response('Entry not found', { status: 404 });
}

describe('Transformers.js pinned revision (BST-2003, upstream #1751)', () => {
  beforeEach(() => {
    requested = [];
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    env.fetch = hub;
    const wasm = env.backends.onnx.wasm;
    if (!wasm) {
      throw new Error('Browser ONNX Runtime exposes no wasm settings.');
    }
    wasm.wasmPaths = resolveViteOnnxWasmPaths();
  });

  afterEach(() => {
    Object.assign(env, defaults);
  });

  it('lists, probes and loads a pinned model only at its revision', async () => {
    const model = `brainstrike-test/pinned-${crypto.randomUUID()}`;

    // The embedding worker's options; the hub has no weights, so loading stops at the ONNX file.
    await expect(
      pipeline('feature-extraction', model, { device: 'wasm', dtype: 'q8', revision: REVISION })
    ).rejects.toThrow(/model_quantized\.onnx/u);

    const resolved = requested.filter((url) => url.includes('/resolve/'));
    expect(resolved).toContain(
      `https://huggingface.co/${model}/resolve/${REVISION}/tokenizer_config.json`
    );
    expect(resolved.filter((url) => !url.includes(`/resolve/${REVISION}/`))).toEqual([]);
  });
});
