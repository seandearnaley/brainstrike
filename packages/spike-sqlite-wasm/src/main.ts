// BST-1940 spike page: one RPC client per engine worker, driven from Playwright through window.spike.
type Engine = 'sqlite' | 'pglite';

interface Client {
  readonly call: (command: string, input?: unknown) => Promise<unknown>;
  readonly terminate: () => void;
}

function client(engine: Engine): Client {
  const worker =
    engine === 'sqlite'
      ? new Worker(new URL('./sqlite-worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./pglite-worker.ts', import.meta.url), { type: 'module' });
  let next = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  worker.onmessage = (event: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
    const entry = pending.get(event.data.id);
    if (!entry) {
      return;
    }
    pending.delete(event.data.id);
    if (event.data.error === undefined) {
      entry.resolve(event.data.value);
    } else {
      entry.reject(new Error(event.data.error));
    }
  };
  worker.onerror = (event) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`worker error: ${event.message}`));
    }
    pending.clear();
  };
  return {
    call: (command, input) =>
      new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { reject, resolve });
        worker.postMessage({ command, id, input });
      }),
    terminate: () => worker.terminate(),
  };
}

/** Lists every OPFS entry (recursive) with sizes, and scans file bytes for a marker. */
async function opfs(marker?: string) {
  const root = await navigator.storage.getDirectory();
  const entries: { path: string; size: number; marker?: boolean; error?: string }[] = [];
  const needle = marker ? new TextEncoder().encode(marker) : undefined;
  const walk = async (directory: FileSystemDirectoryHandle, prefix: string) => {
    for await (const [name, handle] of directory as unknown as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      const path = `${prefix}/${name}`;
      if (handle.kind === 'directory') {
        await walk(handle as FileSystemDirectoryHandle, path);
        continue;
      }
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        const entry: { path: string; size: number; marker?: boolean } = { path, size: file.size };
        if (needle) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          entry.marker = indexOf(bytes, needle) >= 0;
        }
        entries.push(entry);
      } catch (error) {
        entries.push({
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          path,
          size: -1,
        });
      }
    }
  };
  await walk(root, '');
  return { entries, estimate: await navigator.storage.estimate() };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** packages/app-state factory-reset.ts clearOpfsPGliteStores, with the sahpool directory added to its allowlist. */
async function resetOpfs(names: readonly string[]) {
  const root = await navigator.storage.getDirectory();
  const failures: string[] = [];
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
        failures.push(
          `${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
        );
      }
    }
  }
  return { failures };
}

const clients = new Map<string, Client>();
const spike = {
  call: (key: string, command: string, input?: unknown) => {
    const existing = clients.get(key);
    if (!existing) {
      throw new Error(`no worker ${key}`);
    }
    return existing.call(command, input);
  },
  opfs,
  resetOpfs,
  start: (key: string, engine: Engine) => {
    clients.set(key, client(engine));
    return key;
  },
  terminate: (key: string) => {
    clients.get(key)?.terminate();
    clients.delete(key);
  },
};
(globalThis as unknown as { spike: typeof spike }).spike = spike;
document.title = 'bst1940-spike ready';
