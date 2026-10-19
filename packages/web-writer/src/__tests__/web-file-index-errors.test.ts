import { IndexerError } from '@brainstrike/indexer/browser';
import { WebStateStore, WebStateStoreError } from '@brainstrike/web-state-store';
import { afterEach, expect, it, vi } from 'vitest';
import { WebFileIndex } from '../web-writer-client';

class FixtureWorker extends EventTarget implements Worker {
  onerror: Worker['onerror'] = null;
  onmessage: Worker['onmessage'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  postMessage(): void {
    this.onmessage?.call(
      this,
      new MessageEvent('message', {
        data: {
          kind: 'lease',
          leader: true,
          lease: { epoch: 1, instanceId: 'fixture-writer' },
        },
      })
    );
  }
  terminate(): void {}
}
const stores: WebStateStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  vi.restoreAllMocks();
});
async function rejectingStore(cause: Error): Promise<WebStateStore> {
  const store = await WebStateStore.open(new FixtureWorker(), { name: 'error-adapter-fixture' });
  stores.push(store);
  vi.spyOn(store, 'extension').mockRejectedValue(cause);
  return store;
}

it('retains the coded local store refusal without changing the public indexer fault', async () => {
  const cause = new WebStateStoreError({
    code: 'rebuild-required',
    error: 'Explicitly rebuild the index.',
    errorKind: 'failed',
  });
  Object.defineProperty(cause, 'cause', { value: new Error('PRIVATE worker detail') });
  const store = await rejectingStore(cause);
  const index = new WebFileIndex(store);
  const failed = index.info();
  await expect(failed).rejects.toBeInstanceOf(IndexerError);
  await expect(failed).rejects.toSatisfy((error: IndexerError) => error.cause === cause);
  await expect(failed).rejects.toMatchObject({
    code: 'rebuild-required',
    message: 'Explicitly rebuild the index.',
  });
  expect(store.extension).toHaveBeenCalledWith('files.info', null);
  const error: unknown = await failed.catch((failure: unknown) => failure);
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    code: 'rebuild-required',
    name: 'IndexerError',
  });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE|cause|stack/);
});

it('propagates uncoded errors and caller abort reasons by identity', async () => {
  for (const cause of [
    new WebStateStoreError({ error: 'Closed.', errorKind: 'closed' }),
    new DOMException('Cancelled', 'AbortError'),
  ]) {
    const store = await rejectingStore(cause);
    await expect(new WebFileIndex(store).info()).rejects.toBe(cause);
  }
});
