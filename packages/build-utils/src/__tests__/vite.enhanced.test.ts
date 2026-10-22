import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const {
  fullReloadOnCompilerHotspots,
  isContextActionSystemModule,
  getAssistantOptimizeDepsInclude,
  getCoreAppOptimizeDepsInclude,
  getDatabaseOptimizeDepsInclude,
  getHeavyRuntimeOptimizeDepsExclude,
  getWorkerpoolBrowserStubAliases,
  getLazySurfaceOptimizeDepsEntries,
} = await import('../vite.js');

describe('isContextActionSystemModule', () => {
  it('matches the core context-actions package and feature context-actions modules', () => {
    expect(isContextActionSystemModule('/workspace/packages/context-actions/src/registry.ts')).toBe(
      true
    );
    expect(
      isContextActionSystemModule(
        '/workspace/packages/file-explorer-ui/src/context-actions/file-actions.ts'
      )
    ).toBe(true);
  });

  it('matches the commands registry at its context-actions subpath home', () => {
    expect(
      isContextActionSystemModule('/workspace/packages/context-actions/src/commands/define.ts')
    ).toBe(true);
  });

  it('never matches node_modules', () => {
    expect(
      isContextActionSystemModule('/workspace/node_modules/some-lib/context-actions/index.js')
    ).toBe(false);
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
      modules: [],
      server: { moduleGraph: { invalidateModule: vi.fn() }, ws: { send } },
      timestamp: 42,
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
      modules: [],
      server: { moduleGraph: { invalidateModule: vi.fn() }, ws: { send } },
      timestamp: 42,
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
