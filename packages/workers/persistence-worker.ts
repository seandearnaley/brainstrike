import { MemoryStorageAdapter, WebStorageAdapter } from '@brainstrike/storage';
import type { StorageAdapter } from '@brainstrike/storage';

interface PersistMessage {
  name: string;
  value: string;
}

const debounceMs = 200;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PersistMessage | null = null;

const adapter: StorageAdapter = typeof self !== 'undefined' && 'localStorage' in self
  ? new WebStorageAdapter(localStorage)
  : new MemoryStorageAdapter();

self.onmessage = (event: MessageEvent<PersistMessage>) => {
  pending = event.data;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (!pending) return;
    const { name, value } = pending;
    pending = null;
    timer = null;
    await adapter.setItem(name, value);
  }, debounceMs);
};
