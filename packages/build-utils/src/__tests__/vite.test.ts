import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { HmrContext } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  createCspQualifiedEvalWarningFilter,
  fullReloadOnCompilerHotspots,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getLazySurfaceOptimizeDepsEntries,
  getTreeSitterGrammarCopyTargets,
  getWorkerpoolBrowserStubAliases,
  getWorkspaceSourceOptimizeDepsInclude,
  isContextActionSystemModule,
  isSanitizedPersistMergeModule,
  isZustandModule,
} = await import('../vite.js');

afterEach(() => {
  vi.resetAllMocks();
});

function toVitePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

describe('createCspQualifiedEvalWarningFilter', () => {
  it.each([
    '../../node_modules/.pnpm/web-tree-sitter@0.27.1/node_modules/web-tree-sitter/web-tree-sitter.js',
  ])('suppresses the CSP-qualified EVAL warning from %s', (id) => {
    const defaultHandler = vi.fn();

    createCspQualifiedEvalWarningFilter()(
      'warn',
      {
        code: 'EVAL',
        id,
        message: 'Use of direct eval',
      },
      defaultHandler
    );

    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it('accepts Rolldown location metadata when no module id is present', () => {
    const defaultHandler = vi.fn();

    createCspQualifiedEvalWarningFilter()(
      'warn',
      {
        code: 'EVAL',
        loc: {
          column: 33,
          file: String.raw`C:\repo\node_modules\.pnpm\web-tree-sitter@0.27.1\node_modules\web-tree-sitter\web-tree-sitter.js`,
          line: 2978,
        },
        message: 'Use of direct eval',
      },
      defaultHandler
    );

    expect(defaultHandler).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: 'CIRCULAR_DEPENDENCY',
      id: '../../node_modules/.pnpm/web-tree-sitter@0.27.1/node_modules/web-tree-sitter/web-tree-sitter.js',
      message: 'A different warning from an allowlisted module',
    },
    {
      code: 'EVAL',
      id: '../../node_modules/.pnpm/web-tree-sitter@0.27.2/node_modules/web-tree-sitter/web-tree-sitter.js',
      message: 'An unqualified future tree-sitter version',
    },
    {
      code: 'EVAL',
      id: '../../node_modules/.pnpm/web-tree-sitter@0.27.1/node_modules/web-tree-sitter/unreviewed.js',
      message: 'An unqualified module in the current version',
    },
    {
      code: 'EVAL',
      id: '../../node_modules/.pnpm/other-runtime@1.0.0/node_modules/other-runtime/index.js',
      message: 'An unexpected direct eval',
    },
  ])('forwards non-qualified warnings unchanged', (log) => {
    const defaultHandler = vi.fn();

    createCspQualifiedEvalWarningFilter()('warn', log, defaultHandler);

    expect(defaultHandler).toHaveBeenCalledExactlyOnceWith('warn', log);
  });
});

describe('assistant vite helpers', () => {
  test('prebundles resolvable dependencies of excluded workspace sources before a lazy surface opens', () => {
    const entries = getWorkspaceSourceOptimizeDepsInclude();
    expect(entries).toEqual(
      expect.arrayContaining([
        '@brainstrike/ui > @codemirror/view',
        '@brainstrike/ui > mermaid',
        '@brainstrike/utils > ignore',
        '@brainstrike/settings-ui > @tanstack/react-table',
        'zustand/vanilla',
      ])
    );
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      const parts = entry.split(' > ');
      const owner = parts.length === 2 ? parts[0]?.replace('@brainstrike/', '') : 'build-utils';
      const dependency = parts.at(-1);
      expect(dependency).toBeTruthy();
      const require = createRequire(
        path.resolve(import.meta.dirname, '../../../', owner ?? '', 'package.json')
      );
      expect(require.resolve(dependency ?? '')).toBeTruthy();
    }
  });

  test('returns shared startup optimize-deps package ids', () => {
    expect(getCoreAppOptimizeDepsInclude()).toEqual(
      expect.arrayContaining([
        'idb',
        'minimatch',
        'pino',
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
        '@assistant-ui/react-streamdown',
        'react-shiki/core',
        'remark-gfm',
        'shiki/wasm',
        '@shikijs/themes/github-light',
        '@shikijs/langs/typescript',
      ])
    );
    expect(entries.some((entry) => entry.includes('@assistant-ui/styles'))).toBe(false);
    // BST-1645: `@assistant-ui/react-data-stream` is NOT a dependency of this
    // repo. The renderer drives assistant-stream's DataStreamDecoder through a
    // bespoke `ChatModelAdapter` on `useLocalRuntime`
    // (packages/assistant-ui/src/data-stream-runtime.ts) because the vendor's
    // `useDataStreamRuntime` owns its chat-model slot and does not support
    // human-in-the-loop tools. Prebundling a package nothing imports only
    // duplicated `@ai-sdk/provider` in the lockfile.
    expect(entries.some((entry) => entry.includes('@assistant-ui/react-data-stream'))).toBe(false);
  });

  test('returns heavy runtime optimize-deps exclusions', () => {
    expect(getHeavyRuntimeOptimizeDepsExclude()).toEqual(
      expect.arrayContaining(['@huggingface/transformers'])
    );
  });

  test('returns lazy-surface entry points for the assistant surfaces', () => {
    const appDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-app-'));
    writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');
    const entries = getLazySurfaceOptimizeDepsEntries(appDir);

    expect(entries).toEqual([
      `${toVitePath(appDir)}/index.html`,
      expect.stringContaining('/packages/app-shell/src/assistant-chat-panel.tsx'),
      expect.stringContaining('/packages/app-shell/src/assistant-ui-panel-wrapper-lazy.tsx'),
      expect.stringContaining('/packages/assistant-ui/src/assistant-ui-panel.tsx'),
      expect.stringContaining('/packages/assistant-ui/src/markdown-text.tsx'),
    ]);
  });

  test('fails fast when a required lazy-surface entry is missing', () => {
    const appDir = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-app-'));
    writeFileSync(path.join(appDir, 'index.html'), '<!doctype html>');

    expect(() =>
      getLazySurfaceOptimizeDepsEntries(
        appDir,
        (entry) => !entry.includes('/packages/assistant-ui/src/markdown-text.tsx')
      )
    ).toThrow(/Lazy-surface optimizeDeps entry does not exist/);
  });

  test('classifies context-action system modules for chunk co-location', () => {
    // Core package + feature context-actions modules + commands registry are
    // grouped into ONE chunk (circular chunk-init TDZ guard — see vite.ts).
    expect(isContextActionSystemModule('/workspace/packages/context-actions/src/registry.ts')).toBe(
      true
    );
    expect(
      isContextActionSystemModule(
        '/workspace/packages/file-explorer-ui/src/context-actions/file-entry-actions.ts'
      )
    ).toBe(true);
    expect(
      isContextActionSystemModule(
        '/workspace/packages/context-actions/src/commands/command-registry.ts'
      )
    ).toBe(true);
    // node_modules and unrelated app code stay under default chunking.
    expect(isContextActionSystemModule('/workspace/node_modules/context-actions/index.js')).toBe(
      false
    );
    expect(isContextActionSystemModule('/workspace/packages/ui/src/button.tsx')).toBe(false);
  });

  test('classifies only the installed zustand package as its vendor chunk', () => {
    expect(isZustandModule('/workspace/node_modules/zustand/esm/index.mjs')).toBe(true);
    expect(isZustandModule(String.raw`C:\workspace\node_modules\zustand\index.js`)).toBe(true);
    expect(isZustandModule('/workspace/packages/ui/src/zustand-store.ts')).toBe(false);
  });

  test('classifies only the shared sanitized persist merge helper', () => {
    expect(
      isSanitizedPersistMergeModule(
        '/workspace/packages/app-state/src/stores/sanitized-persist-merge.ts'
      )
    ).toBe(true);
    expect(
      isSanitizedPersistMergeModule(
        String.raw`C:\workspace\packages\app-state\dist\stores\sanitized-persist-merge.js`
      )
    ).toBe(true);
    expect(
      isSanitizedPersistMergeModule(
        '/workspace/node_modules/preferences/src/stores/sanitized-persist-merge.ts'
      )
    ).toBe(false);
    expect(
      isSanitizedPersistMergeModule(
        '/workspace/packages/app-state/src/stores/diagnostics-retention-store.ts'
      )
    ).toBe(false);
  });
});

describe('fullReloadOnCompilerHotspots', () => {
  it('triggers full reload for hotspot files', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();
    const invalidateModule = vi.fn();
    const modules = [{ id: 'provider' }, { id: 'consumer' }] as unknown as HmrContext['modules'];
    const ctx = {
      file: path.resolve('/packages/file-explorer-ui/src/foo.ts'),
      modules,
      server: { moduleGraph: { invalidateModule }, ws: { send } },
      timestamp: 42,
    } as unknown as HmrContext;

    const mockPluginContext = {} as never;

    const handleHotUpdate = plugin.handleHotUpdate;
    if (typeof handleHotUpdate === 'function') {
      const result = handleHotUpdate.call(mockPluginContext, ctx);
      expect(invalidateModule).toHaveBeenCalledTimes(2);
      const invalidatedModules = invalidateModule.mock.calls[0]?.[1];
      expect(invalidatedModules).toBeInstanceOf(Set);
      expect(invalidateModule).toHaveBeenNthCalledWith(1, modules[0], invalidatedModules, 42, true);
      expect(invalidateModule).toHaveBeenNthCalledWith(2, modules[1], invalidatedModules, 42, true);
      expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
      expect(result).toEqual([]);
    } else if (
      handleHotUpdate &&
      typeof handleHotUpdate === 'object' &&
      'handler' in handleHotUpdate
    ) {
      const result = handleHotUpdate.handler.call(mockPluginContext, ctx);
      expect(invalidateModule).toHaveBeenCalledTimes(2);
      const invalidatedModules = invalidateModule.mock.calls[0]?.[1];
      expect(invalidatedModules).toBeInstanceOf(Set);
      expect(invalidateModule).toHaveBeenNthCalledWith(1, modules[0], invalidatedModules, 42, true);
      expect(invalidateModule).toHaveBeenNthCalledWith(2, modules[1], invalidatedModules, 42, true);
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
    const baseDir = '/tmp/brainstrike-app';
    const stubDir = path.resolve(baseDir, '../../packages/build-utils/src/browser-node-stubs');
    const aliases = getWorkerpoolBrowserStubAliases(baseDir);
    expect(aliases['child_process']).toBe(toVitePath(path.resolve(stubDir, 'child-process.ts')));
    expect(aliases['os']).toBe(toVitePath(path.resolve(stubDir, 'os.ts')));
    expect(aliases['worker_threads']).toBe(toVitePath(path.resolve(stubDir, 'worker-threads.ts')));
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
    expect(pythonTarget?.src).toBe(
      toVitePath(
        path.resolve('/tmp/brainstrike-app', '../../packages/chunking-worker/grammars/python.wasm')
      )
    );
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
