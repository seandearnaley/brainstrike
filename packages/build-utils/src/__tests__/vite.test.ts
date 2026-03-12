import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HmrContext } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getLazySurfaceOptimizeDepsEntries,
  resolveAssistantVendorChunk,
} = await import('../vite');

afterEach(() => {
  vi.resetAllMocks();
});

describe('findPGliteWasm', () => {
  it('returns path when wasm exists', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pglite-'));
    const appDir = path.join(tmp, 'app');
    const wasmDir = path.join(appDir, 'node_modules/@electric-sql/pglite/dist');
    mkdirSync(wasmDir, { recursive: true });
    const wasmFile = path.join(wasmDir, 'pglite.wasm');
    writeFileSync(wasmFile, '');

    expect(findPGliteWasm(appDir)).toBe(wasmFile);
  });

  it('returns null when wasm is missing', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pglite-'));
    const appDir = path.join(tmp, 'app');
    mkdirSync(appDir, { recursive: true });

    expect(findPGliteWasm(appDir)).toBeNull();
  });
});

describe('assistant vite helpers', () => {
  test('returns resolved assistant optimize-deps entries', () => {
    const entries = getAssistantOptimizeDepsInclude();

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/@assistant-ui/react/'),
        expect.stringContaining('/@assistant-ui/react-data-stream/'),
        expect.stringContaining('/@assistant-ui/react-markdown/'),
        expect.stringContaining('/react-shiki/'),
        expect.stringContaining('/remark-gfm/'),
        expect.stringContaining('/shiki/'),
        expect.stringContaining('/@shikijs/themes/'),
        expect.stringContaining('/@shikijs/langs/'),
      ])
    );
    expect(entries.some((entry) => entry.includes('@assistant-ui/styles'))).toBe(false);
  });

  test('returns resolved database lazy-panel optimize-deps entries', () => {
    expect(getDatabaseOptimizeDepsInclude()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/jszip/'),
        expect.stringContaining('/file-saver/'),
        expect.stringContaining('/react-resizable-panels/'),
      ])
    );
  });

  test('returns lazy-surface entry points for assistant and database tabs', () => {
    const entries = getLazySurfaceOptimizeDepsEntries('/tmp/brainstrike-app');

    expect(entries).toEqual([
      '/tmp/brainstrike-app/index.html',
      expect.stringContaining('/packages/app-shell/src/assistant-ui-panel-wrapper.tsx'),
      expect.stringContaining('/packages/app-shell/src/database-tab-chunk.tsx'),
    ]);
  });

  test('classifies assistant vendor chunks consistently', () => {
    expect(
      resolveAssistantVendorChunk('/workspace/node_modules/@assistant-ui/react/index.js')
    ).toBe('assistant-vendor');
    expect(
      resolveAssistantVendorChunk('/workspace/node_modules/@shikijs/langs/typescript.mjs')
    ).toBe('assistant-markdown-vendor');
    expect(resolveAssistantVendorChunk('/workspace/node_modules/react/index.js')).toBeUndefined();
  });
});

describe('fullReloadOnCompilerHotspots', () => {
  it('triggers full reload for hotspot files', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();
    const ctx = {
      file: path.resolve('/packages/file-explorer-ui/src/foo.ts'),
      server: { ws: { send } },
    } as unknown as HmrContext;

    const mockPluginContext = {} as never;

    const handleHotUpdate = plugin.handleHotUpdate;
    if (typeof handleHotUpdate === 'function') {
      const result = handleHotUpdate.call(mockPluginContext, ctx);
      expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
      expect(result).toEqual([]);
    } else if (
      handleHotUpdate &&
      typeof handleHotUpdate === 'object' &&
      'handler' in handleHotUpdate
    ) {
      const result = handleHotUpdate.handler.call(mockPluginContext, ctx);
      expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
      expect(result).toEqual([]);
    }
  });

  it('does nothing for non-hotspot files', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();
    const ctx = {
      file: 'bar.ts',
      server: { ws: { send } },
    } as unknown as HmrContext;

    const mockPluginContext = {} as never;

    const handleHotUpdate = plugin.handleHotUpdate;
    if (typeof handleHotUpdate === 'function') {
      const result = handleHotUpdate.call(mockPluginContext, ctx);
      expect(send).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    } else if (
      handleHotUpdate &&
      typeof handleHotUpdate === 'object' &&
      'handler' in handleHotUpdate
    ) {
      const result = handleHotUpdate.handler.call(mockPluginContext, ctx);
      expect(send).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    }
  });
});
