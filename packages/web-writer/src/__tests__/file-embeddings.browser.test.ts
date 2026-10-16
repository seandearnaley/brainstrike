/**
 * The web file index's document embeddings in Chromium (BST-1940): desktop's
 * embedding stack, hosted in a worker as the index worker hosts it, running the
 * production embedding worker over a synthetic Transformers runtime.
 */
import type { CanonicalDocumentEmbeddingsPayload } from '@brainstrike/canonical-ingestion/browser';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestWorkerReply, TestWorkerRequest } from './fixtures/file-embeddings.test-worker';
import { expectedVector } from './fixtures/synthetic-embedding';
import syntheticEmbeddingWorkerUrl from './fixtures/synthetic-embedding.worker.ts?worker&url';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
interface Load {
  readonly device: string;
  readonly dtype: string;
  readonly model: string;
  readonly revision: string | null;
}

const REVISION = '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8';
const payload = (
  texts: string[],
  plan: Partial<CanonicalDocumentEmbeddingsPayload['inferencePlan']> = {}
): CanonicalDocumentEmbeddingsPayload => {
  const inferencePlan = {
    device: 'wasm',
    dimensions: 3,
    dtype: 'q8',
    modelId: 'brainstrike-test/document-model',
    prompts: { document: 'passage: ', query: 'query: ' },
    revision: REVISION,
    ...plan,
  } as const;
  return {
    dimensions: inferencePlan.dimensions,
    inferencePlan,
    modelId: inferencePlan.modelId,
    modelKey: `local::${inferencePlan.modelId}`,
    texts,
  };
};

const open: Array<{ readonly channel: BroadcastChannel; readonly worker: Worker }> = [];

function startHost() {
  const name = `synthetic-embedding-${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  const loads: Load[] = [];
  channel.onmessage = (event: MessageEvent<Load & { readonly kind: string }>) => {
    const { kind: _kind, ...load } = event.data;
    loads.push(load);
  };
  const embedder = new URL(syntheticEmbeddingWorkerUrl, location.href);
  embedder.hash = `channel=${name}`;
  const host = new URL('./fixtures/file-embeddings.test-worker.ts', import.meta.url);
  host.hash = `embedder=${encodeURIComponent(embedder.href)}`;
  const worker = new Worker(host, { type: 'module' });
  open.push({ channel, worker });
  let nextId = 1;
  const call = (request: WithoutId<TestWorkerRequest>): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<TestWorkerReply>) => {
        if (event.data.id !== id) {
          return;
        }
        worker.removeEventListener('message', onMessage);
        if (event.data.ok) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error));
        }
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ ...request, id });
    });
  };
  return { call, loads };
}

afterEach(() => {
  for (const { channel, worker } of open.splice(0)) {
    channel.close();
    worker.terminate();
  }
});

describe('the file index worker embeds documents through the shared embedding stack', () => {
  it('embeds a batch in a worker, with its model prompt, as its plan states', async () => {
    const host = startHost();
    await expect(host.call({ kind: 'realm' })).resolves.toEqual({
      window: 'undefined',
      worker: 'function',
    });

    const texts = ['first chunk', 'second chunk of text', 'third'];
    const vectors = (await host.call({ kind: 'embed', payload: payload(texts) })) as number[][];

    // The catalog's document prompt reaches the model with each text.
    expect(vectors).toEqual(texts.map((text) => expectedVector(`passage: ${text}`)));
    // Loads are reported on a BroadcastChannel, which may deliver after the reply.
    await expect
      .poll(() => host.loads)
      .toEqual([
        {
          device: 'wasm',
          dtype: 'q8',
          model: 'brainstrike-test/document-model',
          revision: REVISION,
        },
      ]);
  });

  it('embeds with the plan it is given: a changed prompt, model or execution replaces the loaded one', async () => {
    const host = startHost();
    await expect(host.call({ kind: 'embed', payload: payload(['one']) })).resolves.toEqual([
      expectedVector('passage: one'),
    ]);
    const reprompted = payload(['one'], { prompts: { document: 'doc: ', query: 'q: ' } });
    await expect(host.call({ kind: 'embed', payload: reprompted })).resolves.toEqual([
      expectedVector('doc: one'),
    ]);

    const other = payload(['three'], { dtype: 'fp32', modelId: 'brainstrike-test/other-model' });
    const { revision: _revision, ...unpinned } = other.inferencePlan;
    await expect(
      host.call({ kind: 'embed', payload: { ...other, inferencePlan: unpinned } })
    ).resolves.toEqual([expectedVector('passage: three')]);
    await expect
      .poll(() => host.loads.at(-1))
      .toEqual({
        device: 'wasm',
        dtype: 'fp32',
        model: 'brainstrike-test/other-model',
        revision: null,
      });
  });

  it("embeds a search query with the model's query prompt, on the plan it is given", async () => {
    const host = startHost();
    const { texts: _texts, ...plan } = payload([]);
    await expect(
      host.call({ kind: 'query', payload: { ...plan, query: 'kestrel' } })
    ).resolves.toEqual(expectedVector('query: kestrel'));
    // The same plan's documents still embed with the document prompt.
    await expect(host.call({ kind: 'embed', payload: payload(['kestrel']) })).resolves.toEqual([
      expectedVector('passage: kestrel'),
    ]);
  });

  it('refuses vectors that differ from the plan', async () => {
    const host = startHost();
    // The model yields three dimensions; the plan states four.
    const wide = payload(['text'], { dimensions: 4 });
    const { revision: _revision, ...unpinned } = wide.inferencePlan;
    await expect(
      host.call({ kind: 'embed', payload: { ...wide, inferencePlan: unpinned } })
    ).rejects.toThrow(/invalid model, dimensions or vector values/u);
    const { texts: _texts, ...plan } = wide;
    await expect(
      host.call({ kind: 'query', payload: { ...plan, inferencePlan: unpinned, query: 'text' } })
    ).rejects.toThrow(/invalid model, dimensions or vector values/u);
  });

  it('refuses a plan its embedder cannot load, visibly, and serves the next one', async () => {
    const host = startHost();
    await expect(
      host.call({
        kind: 'embed',
        payload: payload(['text'], { modelId: 'brainstrike-test/broken-model' }),
      })
    ).rejects.toThrow(/no model brainstrike-test\/broken-model/u);
    await expect(host.call({ kind: 'embed', payload: payload(['text']) })).resolves.toEqual([
      expectedVector('passage: text'),
    ]);
  });

  it('refuses an aborted call, and every call after close', async () => {
    const host = startHost();
    await expect(
      host.call({ abort: true, kind: 'embed', payload: payload(['text']) })
    ).rejects.toThrow(/AbortError/u);

    // The one load is the next call's: the aborted call loaded nothing.
    await host.call({ kind: 'embed', payload: payload(['text']) });
    await expect
      .poll(() => host.loads)
      .toEqual([
        {
          device: 'wasm',
          dtype: 'q8',
          model: 'brainstrike-test/document-model',
          revision: REVISION,
        },
      ]);
    await host.call({ kind: 'close' });
    await expect(host.call({ kind: 'embed', payload: payload(['text']) })).rejects.toThrow(
      /embedder is closed/u
    );
  });
});
