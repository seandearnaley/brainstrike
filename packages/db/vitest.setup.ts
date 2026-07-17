import { Blob as NodeBlob } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, vi } from 'vitest';

// Increase global hook timeout to tolerate WASM warmup under parallel runs
vi.setConfig({ hookTimeout: 30_000 });

if (typeof Blob === 'undefined' || typeof Blob.prototype.arrayBuffer !== 'function') {
  // @ts-expect-error - assign Node's Blob polyfill for tests
  globalThis.Blob = NodeBlob;
}

if (!(Buffer.prototype as unknown as { arrayBuffer?: () => ArrayBuffer }).arrayBuffer) {
  Object.defineProperty(Buffer.prototype, 'arrayBuffer', {
    configurable: true,
    enumerable: false,
    value(this: Buffer) {
      const { buffer, byteOffset, byteLength } = this;
      return buffer.slice(byteOffset, byteOffset + byteLength);
    },
    writable: true,
  });
}

const nativeFetch = globalThis.fetch?.bind(globalThis);
if (!nativeFetch) {
  throw new Error('Global fetch is required for PGlite tests.');
}

globalThis.fetch = async (input: unknown, init?: unknown) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : typeof input === 'object' && input && 'url' in input
          ? String((input as { url?: string }).url)
          : String(input);

  if (url.startsWith('file:')) {
    const data = await readFile(new URL(url));
    return new Response(data);
  }

  return nativeFetch(input as any, init as any);
};

beforeAll(async () => {
  const { wasmLoader } = await import('./src/wasm-loader');
  await wasmLoader.ensureWasmLoaded();
});

afterAll(async () => {
  // No-op for now; placeholder for future cleanup hooks.
});
