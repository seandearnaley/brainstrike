import Module from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const exposed = new Map<string, Record<string, unknown>>();
const electron = {
  contextBridge: {
    exposeInMainWorld: (name: string, api: Record<string, unknown>): void => {
      exposed.set(name, api);
    },
  },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') },
};

type ModuleLoader = (this: typeof Module, id: string, ...rest: unknown[]) => unknown;
const loader = Module as unknown as { _load: ModuleLoader };

beforeAll(async () => {
  // Use the real preload's CJS Electron seam, as the existing contract suite does.
  // Shared jsdom setup is not evidence of the production bridge surface.
  const original = loader._load;
  loader._load = function (this: typeof Module, id: string, ...rest: unknown[]): unknown {
    return id === 'electron' ? electron : original.call(this, id, ...rest);
  };
  try {
    await import('../../preload');
  } finally {
    loader._load = original;
  }
});

describe('preload bridge APIs', () => {
  it('exposes window.secrets with expected methods', () => {
    const secrets = exposed.get('secrets');
    expect(secrets).toBeDefined();
    expect(typeof secrets?.['saveKey']).toBe('function');
    expect(typeof secrets?.['getKey']).toBe('function');
    expect(typeof secrets?.['deleteKey']).toBe('function');
    expect(typeof secrets?.['list']).toBe('function');
    expect(typeof secrets?.['listStored']).toBe('function');
    expect(typeof secrets?.['clearAll']).toBe('function');
  });

  it('exposes the shared host without a second aggregate agent bridge', () => {
    expect(typeof exposed.get('agentHost')?.['connect']).toBe('function');
    expect(exposed.has('agent')).toBe(false);
  });

  it('exposes window.llmHost with lifecycle methods', () => {
    const llmHost = exposed.get('llmHost');
    expect(llmHost).toBeDefined();
    expect(typeof llmHost?.['ensureStarted']).toBe('function');
    expect(typeof llmHost?.['getStatus']).toBe('function');
    expect(typeof llmHost?.['stop']).toBe('function');
    expect(typeof llmHost?.['reset']).toBe('function');
    expect(typeof llmHost?.['onProgress']).toBe('function');
    expect(typeof llmHost?.['reportProgress']).toBe('function');
  });
});
