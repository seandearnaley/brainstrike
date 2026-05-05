import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
const originalNodeEnv = process.env['NODE_ENV'];

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

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

vi.mock('electron', () => ({
  app: undefined,
}));

describe('db-main utility process environment', () => {
  beforeEach(() => {
    vi.resetModules();
    installUtilityProcessParentPort();
    process.env['BRAINSTRIKE_DB_ROOT_PATH'] = '/mock/brainstrike-root';
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
    restoreEnvValue('BRAINSTRIKE_DB_ROOT_PATH', originalDbRootPath);
    restoreEnvValue('NODE_ENV', originalNodeEnv);
  });

  it('resolves diagnostics paths from the injected database root without Electron app access', async () => {
    const { getDatabaseDiagnostics } = await import('../../db-main');

    expect(getDatabaseDiagnostics()).toMatchObject({
      appDataDir: '/mock/brainstrike-root/profiles/test',
      dataDir: '/mock/brainstrike-root/profiles/test/pgdata',
    });
  });
});
