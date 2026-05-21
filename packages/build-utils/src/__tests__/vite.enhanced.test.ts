import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  findPGliteWasm,
  fullReloadOnCompilerHotspots,
  resolveAssistantVendorChunk,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getWorkerpoolBrowserStubAliases,
  getLazySurfaceOptimizeDepsEntries,
} = await import('../vite');

function createWorkspacePaths(prefix: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const appDir = path.join(root, 'apps', 'web');
  const pnpmDir = path.join(root, 'node_modules/.pnpm');
  mkdirSync(appDir, { recursive: true });
  return { appDir, pnpmDir };
}

describe('findPGliteWasm - Enhanced Coverage', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('pnpm directory scanning', () => {
    it('should find wasm in pnpm directory structure', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-pnpm-');
      const pgliteVersion = '@electric-sql+pglite@0.1.5';
      const wasmDir = path.join(pnpmDir, pgliteVersion, 'node_modules/@electric-sql/pglite/dist');

      mkdirSync(wasmDir, { recursive: true });
      const wasmFile = path.join(wasmDir, 'pglite.wasm');
      writeFileSync(wasmFile, '');

      const result = findPGliteWasm(appDir);
      expect(result).toBe(wasmFile);
    });

    it('should handle multiple pglite versions in pnpm directory', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-multi-');

      // Create multiple versions
      const version1 = '@electric-sql+pglite@0.1.4';
      const version2 = '@electric-sql+pglite@0.1.5';

      const wasmDir1 = path.join(pnpmDir, version1, 'node_modules/@electric-sql/pglite/dist');
      const wasmDir2 = path.join(pnpmDir, version2, 'node_modules/@electric-sql/pglite/dist');

      mkdirSync(wasmDir1, { recursive: true });
      mkdirSync(wasmDir2, { recursive: true });

      const wasmFile1 = path.join(wasmDir1, 'pglite.wasm');
      const wasmFile2 = path.join(wasmDir2, 'pglite.wasm');

      writeFileSync(wasmFile1, 'version1');
      writeFileSync(wasmFile2, 'version2');

      const result = findPGliteWasm(appDir);
      // Should find one of them
      expect(result).toMatch(/pglite\.wasm$/);
      expect([wasmFile1, wasmFile2]).toContain(result);
    });

    it('should skip non-pglite directories in pnpm', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-other-');

      // Create directories that don't match @electric-sql+pglite@
      const otherDir1 = path.join(pnpmDir, 'some-other-package@1.0.0');
      const otherDir2 = path.join(pnpmDir, '@electric-sql+other@2.0.0');

      mkdirSync(otherDir1, { recursive: true });
      mkdirSync(otherDir2, { recursive: true });

      const result = findPGliteWasm(appDir);
      expect(result).toBeNull();
    });

    it('should handle pnpm directory without valid pglite versions', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-no-wasm-');
      const pgliteDir = path.join(pnpmDir, '@electric-sql+pglite@0.1.5');

      // Create directory but no wasm file
      mkdirSync(pgliteDir, { recursive: true });

      const result = findPGliteWasm(appDir);
      expect(result).toBeNull();
    });

    it('should handle pnpm directory scan errors gracefully', () => {
      const { appDir } = createWorkspacePaths('pglite-no-pnpm-');

      // No pnpm directory exists, should not throw
      expect(() => findPGliteWasm(appDir)).not.toThrow();

      const result = findPGliteWasm(appDir);
      expect(result).toBeNull();
    });

    it('should skip files in pnpm directory (not directories)', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-files-');

      mkdirSync(pnpmDir, { recursive: true });

      // Create a file instead of directory
      const filePath = path.join(pnpmDir, '@electric-sql+pglite@0.1.5');
      writeFileSync(filePath, 'not a directory');

      const result = findPGliteWasm(appDir);
      expect(result).toBeNull();
    });
  });

  describe('development mode logging', () => {
    it('should log debug message when wasm is found in development mode', async () => {
      process.env['NODE_ENV'] = 'development';
      vi.resetModules();
      const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { findPGliteWasm: findPGliteWasmInDevelopment } = await import('../vite');

      const { appDir } = createWorkspacePaths('pglite-dev-');
      const wasmDir = path.join(appDir, 'node_modules/@electric-sql/pglite/dist');
      mkdirSync(wasmDir, { recursive: true });
      const wasmFile = path.join(wasmDir, 'pglite.wasm');
      writeFileSync(wasmFile, '');

      const result = findPGliteWasmInDevelopment(appDir);
      expect(result).toBe(wasmFile);
      expect(stdoutWrite).toHaveBeenCalledWith(
        `[PGliteLocator] DEBUG Found PGLite WASM {"wasmPath":"${wasmFile}"}\n`
      );
    });

    it('should check both standard paths before pnpm', () => {
      const { appDir, pnpmDir } = createWorkspacePaths('pglite-paths-');

      // Create wasm in standard path (not pnpm)
      const standardWasmDir = path.join(appDir, 'node_modules/@electric-sql/pglite/dist');
      mkdirSync(standardWasmDir, { recursive: true });
      const standardWasm = path.join(standardWasmDir, 'pglite.wasm');
      writeFileSync(standardWasm, '');

      // Also create pnpm structure
      const pgliteVersion = '@electric-sql+pglite@0.1.5';
      const pnpmWasmDir = path.join(
        pnpmDir,
        pgliteVersion,
        'node_modules/@electric-sql/pglite/dist'
      );
      mkdirSync(pnpmWasmDir, { recursive: true });
      const pnpmWasm = path.join(pnpmWasmDir, 'pglite.wasm');
      writeFileSync(pnpmWasm, '');

      // Should prefer standard path
      const result = findPGliteWasm(appDir);
      expect(result).toBe(standardWasm);
    });
  });

  describe('fallback behavior', () => {
    it('should return null and log warning when no wasm found anywhere', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'pglite-none-'));
      const appDir = path.join(tmp, 'app');
      mkdirSync(appDir, { recursive: true });

      const result = findPGliteWasm(appDir);
      expect(result).toBeNull();
    });

    it('should check monorepo-style path (../../node_modules)', () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), 'pglite-mono-'));
      const appDir = path.join(tmp, 'apps/web');
      const wasmDir = path.join(tmp, 'node_modules/@electric-sql/pglite/dist');

      mkdirSync(appDir, { recursive: true });
      mkdirSync(wasmDir, { recursive: true });
      const wasmFile = path.join(wasmDir, 'pglite.wasm');
      writeFileSync(wasmFile, '');

      const result = findPGliteWasm(appDir);
      expect(result).toBe(wasmFile);
    });
  });
});

describe('resolveAssistantVendorChunk', () => {
  it('returns assistant-markdown-vendor for react-markdown dependency', () => {
    expect(
      resolveAssistantVendorChunk('/node_modules/@assistant-ui/react-markdown/dist/index.js')
    ).toBe('assistant-markdown-vendor');
  });

  it('returns assistant-markdown-vendor for shiki dependency', () => {
    expect(resolveAssistantVendorChunk('/node_modules/react-shiki/dist/core.js')).toBe(
      'assistant-markdown-vendor'
    );
  });

  it('returns assistant-vendor for react dependency', () => {
    expect(resolveAssistantVendorChunk('/node_modules/@assistant-ui/react/dist/index.js')).toBe(
      'assistant-vendor'
    );
  });

  it('returns assistant-vendor for data-stream dependency', () => {
    expect(
      resolveAssistantVendorChunk('/node_modules/@assistant-ui/react-data-stream/dist/index.js')
    ).toBe('assistant-vendor');
  });

  it('returns undefined for unrelated modules', () => {
    expect(resolveAssistantVendorChunk('/node_modules/react/index.js')).toBeUndefined();
  });
});

describe('utility getter functions', () => {
  it('getAssistantOptimizeDepsInclude returns an array containing @assistant-ui/react', () => {
    const result = getAssistantOptimizeDepsInclude();
    expect(result).toContain('@assistant-ui/react');
    expect(result.length).toBeGreaterThan(0);
  });

  it('getCoreAppOptimizeDepsInclude returns an array containing zod', () => {
    const result = getCoreAppOptimizeDepsInclude();
    expect(result).toContain('zod');
  });

  it('getDatabaseOptimizeDepsInclude returns an array containing jszip', () => {
    const result = getDatabaseOptimizeDepsInclude();
    expect(result).toContain('jszip');
  });

  it('getHeavyRuntimeOptimizeDepsExclude returns an array containing @huggingface/transformers', () => {
    const result = getHeavyRuntimeOptimizeDepsExclude();
    expect(result).toContain('@huggingface/transformers');
  });
});

describe('getWorkerpoolBrowserStubAliases', () => {
  it('returns aliases for child_process, os, and worker_threads', () => {
    const aliases = getWorkerpoolBrowserStubAliases('/fake/base');
    expect(aliases).toHaveProperty('child_process');
    expect(aliases).toHaveProperty('os');
    expect(aliases).toHaveProperty('worker_threads');
    expect(Object.keys(aliases)).toHaveLength(3);
  });

  it('resolves paths relative to baseDir', () => {
    const aliases = getWorkerpoolBrowserStubAliases('/my/project');
    for (const aliasPath of Object.values(aliases)) {
      expect(aliasPath).toContain('browser-node-stubs');
    }
  });
});

describe('getLazySurfaceOptimizeDepsEntries', () => {
  it('throws when an entry does not exist', () => {
    const alwaysFalse = () => false;
    expect(() => getLazySurfaceOptimizeDepsEntries('/fake/app', alwaysFalse)).toThrow(
      'Lazy-surface optimizeDeps entry does not exist'
    );
  });

  it('returns entries when all files exist', () => {
    const alwaysTrue = () => true;
    const entries = getLazySurfaceOptimizeDepsEntries('/fake/app', alwaysTrue);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toContain('index.html');
  });
});

describe('fullReloadOnCompilerHotspots - Enhanced Coverage', () => {
  it('should return plugin with correct name', () => {
    const plugin = fullReloadOnCompilerHotspots();
    expect(plugin.name).toBe('full-reload-on-compiler-hotspots');
  });

  it('should return empty array when hotspot file changes', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();

    // Create a hotspot file path
    const hotspotFile = path.resolve('/packages/file-explorer-ui/src/components/test.tsx');

    const ctx = {
      file: hotspotFile,
      server: { ws: { send } },
    } as never;

    const mockPluginContext = {} as never;
    const handleHotUpdate = plugin.handleHotUpdate;

    if (typeof handleHotUpdate === 'function') {
      const result = handleHotUpdate.call(mockPluginContext, ctx);
      expect(result).toEqual([]);
    }
  });

  it('should return undefined for non-hotspot files', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();

    const ctx = {
      file: '/some/random/file.ts',
      server: { ws: { send } },
    } as never;

    const mockPluginContext = {} as never;
    const handleHotUpdate = plugin.handleHotUpdate;

    if (typeof handleHotUpdate === 'function') {
      const result = handleHotUpdate.call(mockPluginContext, ctx);
      expect(result).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('should send full-reload message to websocket', () => {
    const plugin = fullReloadOnCompilerHotspots();
    const send = vi.fn();

    const ctx = {
      file: path.resolve('/packages/file-explorer-ui/src/index.ts'),
      server: { ws: { send } },
    } as never;

    const mockPluginContext = {} as never;
    const handleHotUpdate = plugin.handleHotUpdate;

    if (typeof handleHotUpdate === 'function') {
      handleHotUpdate.call(mockPluginContext, ctx);
      expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
