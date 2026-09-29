import { afterEach, describe, expect, it, vi } from 'vitest';

const forkMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userData'),
    isPackaged: false,
  },
  utilityProcess: { fork: forkMock },
}));

// Partial: the manager's transitive imports (worker-runtime -> utils) read
// `LogLevel` at module scope, so the real module has to come through.
vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

describe('DbHostManager test-only diagnostics', () => {
  const originalArgv = process.argv;
  const originalElectronIsE2ETest = process.env['ELECTRON_IS_E2E_TEST'];
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    process.argv = originalArgv;
    if (originalElectronIsE2ETest === undefined) {
      Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
    } else {
      process.env['ELECTRON_IS_E2E_TEST'] = originalElectronIsE2ETest;
    }
    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, 'NODE_ENV');
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('rejects live-query diagnostics outside explicit test mode', async () => {
    process.argv = ['node', 'db-host-manager-test-mode.test.ts'];
    Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
    process.env['NODE_ENV'] = 'production';
    const { createDbHostManager } = await import('../../db-host-manager');
    const manager = createDbHostManager({ entryPath: '/mock/db-host-entry.js' });

    await expect(manager.getLiveQueryDiagnosticsForTests()).rejects.toThrow(
      'DB host live-query diagnostics are available only in test mode.'
    );
    expect(forkMock).not.toHaveBeenCalled();
  });
});
