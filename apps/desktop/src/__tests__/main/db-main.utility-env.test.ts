import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
const originalDbRootPath = process.env['BRAINSTRIKE_DB_ROOT_PATH'];
const originalDbProfile = process.env['BRAINSTRIKE_DB_PROFILE'];
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
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'host-profile';
    process.env['NODE_ENV'] = 'test';
  });

  afterEach(() => {
    // Restores the cwd spy even when an assertion failed first.
    vi.restoreAllMocks();
    vi.resetModules();
    restoreParentPort();
    restoreEnvValue('BRAINSTRIKE_DB_ROOT_PATH', originalDbRootPath);
    restoreEnvValue('BRAINSTRIKE_DB_PROFILE', originalDbProfile);
    restoreEnvValue('NODE_ENV', originalNodeEnv);
  });

  it('resolves diagnostics paths from the injected root and profile without Electron app access', async () => {
    const { getDatabaseDiagnostics } = await import('../../db-main');

    expect(getDatabaseDiagnostics()).toMatchObject({
      appDataDir: path.join('/mock/brainstrike-root', 'profiles', 'host-profile'),
      databaseProfile: 'host-profile',
      dataDir: path.join('/mock/brainstrike-root', 'profiles', 'host-profile', 'pgdata'),
    });
  });

  it('never derives a development profile from cwd or git metadata', async () => {
    process.env['NODE_ENV'] = 'development';
    Reflect.deleteProperty(process.env, 'BRAINSTRIKE_DB_PROFILE');
    const cwdSpy = vi.spyOn(process, 'cwd');
    const { getDatabaseDiagnostics } = await import('../../db-main');

    expect(() => getDatabaseDiagnostics()).toThrow(/BRAINSTRIKE_DB_PROFILE must be set/u);
    expect(cwdSpy).not.toHaveBeenCalled();
  });

  it.each(['BRAINSTRIKE_DB_ROOT_PATH', 'BRAINSTRIKE_DB_PROFILE'])(
    'throws a clear error when %s is missing instead of deriving a location',
    async (name) => {
      Reflect.deleteProperty(process.env, name);
      const { getDatabaseDiagnostics } = await import('../../db-main');

      expect(() => getDatabaseDiagnostics()).toThrow(new RegExp(`${name} must be set`, 'u'));
    }
  );

  it.each([
    ['BRAINSTRIKE_DB_ROOT_PATH', 'undefined'],
    ['BRAINSTRIKE_DB_ROOT_PATH', '   '],
    ['BRAINSTRIKE_DB_PROFILE', 'undefined'],
    ['BRAINSTRIKE_DB_PROFILE', '   '],
  ])('treats %s set to %j as missing', async (name, value) => {
    process.env[name] = value;
    const { getDatabaseDiagnostics } = await import('../../db-main');

    expect(() => getDatabaseDiagnostics()).toThrow(new RegExp(`${name} must be set`, 'u'));
  });
});
