import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HmrContext } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getLazySurfaceOptimizeDepsEntries,
  getTreeSitterGrammarCopyTargets,
  getWorkerpoolBrowserStubAliases,
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
  test('returns shared startup optimize-deps package ids', () => {
    expect(getCoreAppOptimizeDepsInclude()).toEqual(
      expect.arrayContaining([
        'idb',
        'minimatch',
        'pino',
        'react-helmet-async',
        'react-hotkeys-hook',
        'react-router-dom',
        'tiktoken',
        'tiktoken/lite/init',
        'xxhash-wasm',
        'zod',
        'zustand/shallow',
        '@radix-ui/react-accordion',
        '@radix-ui/react-checkbox',
        '@radix-ui/react-dialog',
        '@radix-ui/react-scroll-area',
        '@radix-ui/react-tabs',
        '@radix-ui/react-toast',
      ])
    );
  });

  test('returns assistant optimize-deps package ids', () => {
    const entries = getAssistantOptimizeDepsInclude();

    expect(entries).toEqual(
      expect.arrayContaining([
        '@assistant-ui/react',
        '@assistant-ui/react-data-stream',
        '@assistant-ui/react-markdown',
        'react-shiki/core',
        'remark-gfm',
        'shiki/wasm',
        '@shikijs/themes/github-light',
        '@shikijs/langs/typescript',
      ])
    );
    expect(entries.some((entry) => entry.includes('@assistant-ui/styles'))).toBe(false);
  });

  test('returns database lazy-panel optimize-deps package ids', () => {
    expect(getDatabaseOptimizeDepsInclude()).toEqual(
      expect.arrayContaining(['jszip', 'file-saver', 'react-resizable-panels'])
    );
  });

  test('returns heavy runtime optimize-deps exclusions', () => {
    expect(getHeavyRuntimeOptimizeDepsExclude()).toEqual(
      expect.arrayContaining(['@huggingface/transformers'])
    );
  });

  test('returns lazy-surface entry points for assistant and database surfaces', () => {
    const appDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-app-'));
    writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');
    const entries = getLazySurfaceOptimizeDepsEntries(appDir);

    expect(entries).toEqual([
      `${appDir}/index.html`,
      expect.stringContaining('/packages/app-shell/src/database-panel.tsx'),
      expect.stringContaining('/packages/app-shell/src/assistant-chat-panel.tsx'),
      expect.stringContaining('/packages/app-shell/src/assistant-ui-panel-wrapper-lazy.tsx'),
      expect.stringContaining('/packages/app-shell/src/assistant-ui-panel-wrapper.tsx'),
      expect.stringContaining('/packages/app-shell/src/database-tab.tsx'),
      expect.stringContaining('/packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx'),
      expect.stringContaining('/packages/ui/src/assistant-ui-panel/markdown-text.tsx'),
      expect.stringContaining('/packages/app-shell/src/database-tab-chunk.tsx'),
      expect.stringContaining('/packages/db-explorer/src/database-demo-panel.tsx'),
    ]);
  });

  test('fails fast when a required lazy-surface entry is missing', () => {
    const appDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-app-'));
    writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');

    expect(() =>
      getLazySurfaceOptimizeDepsEntries(
        appDir,
        (entry) => !entry.includes('/packages/db-explorer/src/database-demo-panel.tsx')
      )
    ).toThrow(/Lazy-surface optimizeDeps entry does not exist/);
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

describe('getWorkerpoolBrowserStubAliases', () => {
  it('returns explicit browser-safe aliases for workerpool node builtins', () => {
    const aliases = getWorkerpoolBrowserStubAliases('/tmp/brainstrike-app');
    expect(aliases['child_process']).toBe(
      '/packages/build-utils/src/browser-node-stubs/child-process.ts'
    );
    expect(aliases['os']).toBe('/packages/build-utils/src/browser-node-stubs/os.ts');
    expect(aliases['worker_threads']).toBe(
      '/packages/build-utils/src/browser-node-stubs/worker-threads.ts'
    );
  });
});

describe('getTreeSitterGrammarCopyTargets', () => {
  // The helper centralizes the static-copy target list so apps/web and
  // apps/desktop don't drift. When tree-sitter Phase 1 ships only Python,
  // there's exactly one target; future phases add Rust/Go/Markdown by
  // editing this helper, not every vite config.

  it('returns one target per shipped grammar with dest under assets/grammars', () => {
    const targets = getTreeSitterGrammarCopyTargets('/tmp/brainstrike-app');

    // Phase 1 ships Python only.
    expect(targets).toHaveLength(1);
    expect(targets[0]?.dest).toBe('assets/grammars');
  });

  it('resolves the Python grammar src to the chunking-worker vendored copy', () => {
    const targets = getTreeSitterGrammarCopyTargets('/tmp/brainstrike-app');

    const pythonTarget = targets.find((t) => t.src.endsWith('python.wasm'));
    expect(pythonTarget).toBeDefined();
    // Expected resolution: <baseDir>/../../packages/chunking-worker/grammars/python.wasm
    // (mirrors the findPGliteWasm baseDir convention)
    expect(pythonTarget?.src).toBe('/packages/chunking-worker/grammars/python.wasm');
  });

  it('sets rename.stripBase so the wasm lands flat at dest/<lang>.wasm', () => {
    // Without rename.stripBase=true, vite-plugin-static-copy preserves
    // the absolute source path beyond the workspace root, producing
    // `dist/assets/grammars/packages/chunking-worker/grammars/python.wasm`
    // instead of `dist/assets/grammars/python.wasm`. Confirmed via a real
    // `pnpm -F @brainstrike/web build` run before this assertion landed.
    const targets = getTreeSitterGrammarCopyTargets('/tmp/brainstrike-app');
    expect(targets[0]?.rename).toEqual({ stripBase: true });
  });
});
