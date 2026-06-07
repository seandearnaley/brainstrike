import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function installUtilityProcessParentPort(): void {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: vi.fn(),
      postMessage: vi.fn(),
    },
    writable: true,
  });
}

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  cpSync: vi.fn(),
  existsSync: vi.fn(() => true),
  lstatSync: vi.fn(() => ({
    isDirectory: () => false,
    isFile: () => false,
  })),
  mkdirSync: vi.fn(),
  openSync: vi.fn(() => 123),
  readFileSync: vi.fn(() => ''),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod.default, ...fsMocks },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
  },
}));

describe('db-main coverage helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    installUtilityProcessParentPort();
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.mkdirSync.mockReset();
    fsMocks.rmSync.mockReset();
    fsMocks.cpSync.mockReset();
    fsMocks.readdirSync.mockReturnValue([]);
    fsMocks.openSync.mockReturnValue(123);
    fsMocks.writeFileSync.mockReset();
    fsMocks.closeSync.mockReset();
    fsMocks.unlinkSync.mockReset();
    fsMocks.readFileSync.mockReturnValue('');
    fsMocks.lstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
    });
    process.env['NODE_ENV'] = 'test';
    process.env['BRAINSTRIKE_DB_PROFILE'] = '';
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('fails fast when pgvector extension cannot be loaded', async () => {
    vi.doMock('@electric-sql/pglite-pgvector', () => {
      throw new Error('vector module missing');
    });
    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/pgvector extension is required/i);
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.initializationAttemptCount).toBeGreaterThan(0);
    expect(diagnostics.lastInitializationFailure?.category).toBe('missing-extension');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('classifies wasm abort during extension load as wasm-runtime', async () => {
    vi.doMock('@electric-sql/pglite', () => {
      const moduleRecord: Record<string, unknown> = {};
      Object.defineProperty(moduleRecord, 'PGlite', {
        configurable: true,
        enumerable: true,
        get() {
          throw new Error('Aborted(). Build with -sASSERTIONS for more info.');
        },
      });
      return moduleRecord;
    });
    const { initializeMainDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    await expect(initializeMainDatabase()).rejects.toThrow(/aborted/i);
    const diagnostics = getDatabaseDiagnostics();
    expect(diagnostics.lastInitializationFailure?.category).toBe('wasm-runtime');
    expect(diagnostics.lastInitializationFailure?.stage).toBe('load-extensions');
  });

  it('resetLocalDatabase completes without throwing', async () => {
    const { resetLocalDatabase } = await import('../../db-main');
    await expect(resetLocalDatabase()).resolves.toBeUndefined();
  });
});
