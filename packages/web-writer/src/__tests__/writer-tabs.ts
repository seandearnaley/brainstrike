import {
  type WebStateAppendRow,
  WebStateStore,
  type WebStateStoreConfig,
  webStateNames,
} from '@brainstrike/web-state-store';
import { inject } from 'vitest';

/** The recorded committed runs, stored in Node as Core stores them (`stored-host-corpus.global.ts`). */
export const corpus = inject('storedHostCorpus');

const opened: WebStateStore[] = [];
const pools: string[] = [];

export function storeConfig(build = 'build-1'): WebStateStoreConfig {
  const name = `writer-${crypto.randomUUID()}`;
  pools.push(webStateNames(name).pool);
  return { build, name };
}

/** One tab running the web app's composed writer worker. */
export async function openTab(config: WebStateStoreConfig): Promise<WebStateStore> {
  const worker = new Worker(new URL('../web-writer-worker.ts', import.meta.url), {
    type: 'module',
  });
  const store = await WebStateStore.open(worker, config);
  opened.push(store);
  return store;
}

/** Stores the recorded runs as Core stores them: blobs first, then the rows that name them. */
export async function storeCorpus(store: WebStateStore): Promise<void> {
  for (const [hash, content] of corpus.blobs) {
    await store.putBlob(hash, content);
  }
  await store.append(corpus.rows as readonly WebStateAppendRow[], { boundary: true });
}

/** Closes every tab a test opened and deletes the pools it named. */
export async function closeTabs(): Promise<void> {
  for (const store of opened.splice(0)) {
    store.close();
  }
  const root = await navigator.storage.getDirectory();
  for (const pool of pools.splice(0).flatMap((name) => [name, `${name}--files`])) {
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await root.removeEntry(pool, { recursive: true });
        break;
      } catch (error) {
        if ((error as DOMException).name === 'NotFoundError') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
}
