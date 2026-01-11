import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureCapableAdapter } from '../dev-fixture-adapter';
import type {
  DirectoryHandle,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
} from '../types';

function createBaseAdapter(): FileSystemAdapter {
  return {
    requestDirectoryAccess: vi.fn(async () => {
      throw new Error('requestDirectoryAccess not implemented in test');
    }),
    readDirectory: vi.fn(async () => {
      throw new Error('readDirectory not implemented in test');
    }),
    readDirectoryStreaming: vi.fn(async () => {
      throw new Error('readDirectoryStreaming should not be called when fixture is active');
    }),
    readFile: vi.fn(async (_handle: FileHandle) => {
      throw new Error('readFile not implemented in test');
    }),
    exists: vi.fn(async () => false),
  };
}

describe('createFixtureCapableAdapter (inline fixture)', () => {
  it('streams fixture entries via readDirectoryStreaming when active', async () => {
    const base = createBaseAdapter();
    const baseReadDirectoryStreaming = base.readDirectoryStreaming as unknown as ReturnType<
      typeof vi.fn
    >;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });

    const rootHandle = await adapter.loadInlineFixture();

    const batches: Array<{ nodes: IFileNode[]; done: boolean; total: number }> = [];
    const onBatch: DirectoryStreamCallback = (nodes, meta) => {
      batches.push({ nodes, done: meta.done, total: meta.total });
    };

    await adapter.readDirectoryStreaming?.(rootHandle, onBatch, { batchSize: 2 });

    // Default DEV_INLINE_FIXTURE root contains 4 entries: src/, package.json, README.md, tsconfig.json
    const final = batches.at(-1);
    expect(final).toBeTruthy();
    expect(final?.done).toBe(true);
    expect(final?.total).toBe(4);

    // Ensure we got at least one intermediate batch for batchSize=2
    expect(batches.some((b) => b.done === false)).toBe(true);

    // Ensure base adapter streaming was not invoked while fixture is active
    expect(baseReadDirectoryStreaming).not.toHaveBeenCalled();
  });

  it('delegates readDirectoryStreaming to the base adapter when fixture is not active', async () => {
    const base = createBaseAdapter();
    const baseReadDirectoryStreaming = base.readDirectoryStreaming as unknown as ReturnType<
      typeof vi.fn
    >;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });

    const handle: DirectoryHandle = {
      path: 'root',
      name: 'root',
      kind: 'directory',
      platform: 'web',
      _internal: {} as unknown,
    };

    const onBatch: DirectoryStreamCallback = () => {};

    await expect(
      adapter.readDirectoryStreaming?.(handle, onBatch, { batchSize: 1 })
    ).rejects.toThrow('readDirectoryStreaming should not be called when fixture is active');
    expect(baseReadDirectoryStreaming).toHaveBeenCalled();
  });
});
