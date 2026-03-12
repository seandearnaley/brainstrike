import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HmrContext } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
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
  test('returns the complete assistant optimize-deps include list', () => {
    expect(getAssistantOptimizeDepsInclude()).toEqual(
      expect.arrayContaining([
        '@assistant-ui/react',
        '@assistant-ui/react-data-stream',
        '@assistant-ui/react-markdown',
        '@assistant-ui/styles',
        'react-shiki/core',
        'remark-gfm',
        'shiki/wasm',
        '@shikijs/themes/github-light',
        '@shikijs/langs/typescript',
      ])
    );
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
