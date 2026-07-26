import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => logger,
}));

import {
  applyDesktopEnvFiles,
  getDesktopEnvFileLoadReport,
  parseEnvFileContent,
  resolveDesktopEnvFilePaths,
} from '../../env-file-loader';

const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];
const ORIGINAL_ELECTRON_E2E = process.env['ELECTRON_IS_E2E_TEST'];

function restoreEnvVar(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
    return;
  }
  Reflect.deleteProperty(process.env, key);
}

describe('env-file-loader', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstrike-env-'));
    // The loader is deliberately inert in test mode; every behavioral test here
    // runs as a normal (dev/packaged) launch unless it opts back in.
    Reflect.deleteProperty(process.env, 'NODE_ENV');
    Reflect.deleteProperty(process.env, 'ELECTRON_IS_E2E_TEST');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
    restoreEnvVar('NODE_ENV', ORIGINAL_NODE_ENV);
    restoreEnvVar('ELECTRON_IS_E2E_TEST', ORIGINAL_ELECTRON_E2E);
  });

  function makeDirs(): { appDirectory: string; userDataDirectory: string } {
    const appDirectory = path.join(tempDir, 'app');
    const userDataDirectory = path.join(tempDir, 'user-data');
    fs.mkdirSync(appDirectory, { recursive: true });
    fs.mkdirSync(userDataDirectory, { recursive: true });
    return { appDirectory, userDataDirectory };
  }

  describe('parseEnvFileContent', () => {
    it('parses assignments, comments, blank lines and quoted values', () => {
      const parsed = parseEnvFileContent(
        [
          '# a comment',
          '',
          'OPENAI_API_KEY=sk-plain',
          "ANTHROPIC_API_KEY='sk-single'",
          'GOOGLE_API_KEY="sk-double"',
          'ESCAPED="line\\nbreak"',
          'EMPTY=',
        ].join('\n')
      );

      expect(parsed).toEqual(
        new Map([
          ['OPENAI_API_KEY', 'sk-plain'],
          ['ANTHROPIC_API_KEY', 'sk-single'],
          ['GOOGLE_API_KEY', 'sk-double'],
          ['ESCAPED', 'line\nbreak'],
          ['EMPTY', ''],
        ])
      );
    });

    it.each([
      ['a bare token line', 'OPENAI_API_KEY'],
      ['a spaced assignment', 'OPENAI_API_KEY = sk-test'],
      ['an invalid key', '1BAD=value'],
      ['an unterminated quote', 'OPENAI_API_KEY="sk-test'],
      ['an inline comment', 'OPENAI_API_KEY=sk-test # trailing'],
      ['an unknown escape', 'OPENAI_API_KEY="sk\\qtest"'],
      ['a duplicate key', 'OPENAI_API_KEY=one\nOPENAI_API_KEY=two'],
      ['an export prefix', 'export OPENAI_API_KEY=sk-test'],
    ])('rejects %s', (_label, content) => {
      expect(() => parseEnvFileContent(content)).toThrow();
    });
  });

  describe('resolveDesktopEnvFilePaths', () => {
    it('prefers dev repo files over the user-data file', () => {
      expect(
        resolveDesktopEnvFilePaths({
          appDirectory: '/repo/apps/desktop',
          isPackaged: false,
          userDataDirectory: '/user-data',
        })
      ).toEqual([
        path.join('/repo/apps/desktop', '.env.local'),
        path.join('/repo/apps/desktop', '.env'),
        path.join('/user-data', '.env'),
      ]);
    });

    it('reads only the user-data file when packaged', () => {
      expect(
        resolveDesktopEnvFilePaths({
          appDirectory: '/Applications/BrainStrike.app/Contents/Resources/app.asar',
          isPackaged: true,
          userDataDirectory: '/user-data',
        })
      ).toEqual([path.join('/user-data', '.env')]);
    });
  });

  describe('applyDesktopEnvFiles', () => {
    it('applies file values without overwriting an already-set process env var', () => {
      const { appDirectory, userDataDirectory } = makeDirs();
      fs.writeFileSync(
        path.join(appDirectory, '.env'),
        'OPENAI_API_KEY=from-file\nNEW_KEY=fresh\n'
      );
      const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'from-process' };

      const report = applyDesktopEnvFiles({
        appDirectory,
        env,
        isPackaged: false,
        userDataDirectory,
      });

      expect(env['OPENAI_API_KEY']).toBe('from-process');
      expect(env['NEW_KEY']).toBe('fresh');
      expect(report.appliedKeys).toEqual(['NEW_KEY']);
      expect(report.failures).toEqual([]);
      expect(report.skipped).toBeNull();
    });

    it('lets .env.local win over .env, and the repo win over user data', () => {
      const { appDirectory, userDataDirectory } = makeDirs();
      fs.writeFileSync(path.join(appDirectory, '.env.local'), 'LOCAL_WINS=local\n');
      fs.writeFileSync(path.join(appDirectory, '.env'), 'LOCAL_WINS=repo\nREPO_WINS=repo\n');
      fs.writeFileSync(
        path.join(userDataDirectory, '.env'),
        'LOCAL_WINS=user\nREPO_WINS=user\nUSER_ONLY=user\n'
      );
      const env: NodeJS.ProcessEnv = {};

      applyDesktopEnvFiles({ appDirectory, env, isPackaged: false, userDataDirectory });

      expect(env['LOCAL_WINS']).toBe('local');
      expect(env['REPO_WINS']).toBe('repo');
      expect(env['USER_ONLY']).toBe('user');
    });

    it('rejects a malformed file whole and surfaces the failure visibly', () => {
      const { appDirectory, userDataDirectory } = makeDirs();
      const malformedPath = path.join(appDirectory, '.env');
      fs.writeFileSync(malformedPath, 'GOOD_KEY=good\nthis is not an assignment\n');
      fs.writeFileSync(path.join(userDataDirectory, '.env'), 'OTHER_FILE_KEY=applied\n');
      const env: NodeJS.ProcessEnv = {};

      const report = applyDesktopEnvFiles({
        appDirectory,
        env,
        isPackaged: false,
        userDataDirectory,
      });

      expect(env['GOOD_KEY']).toBeUndefined();
      expect(env['OTHER_FILE_KEY']).toBe('applied');
      expect(report.failures).toEqual([
        expect.objectContaining({ filePath: malformedPath, line: 2 }),
      ]);
      expect(logger.error).toHaveBeenCalled();
      expect(getDesktopEnvFileLoadReport().failures).toHaveLength(1);
    });

    it('never leaks a secret value into the failure message or the report', () => {
      const { appDirectory, userDataDirectory } = makeDirs();
      fs.writeFileSync(path.join(appDirectory, '.env'), 'OPENAI_API_KEY="sk-super-secret\n');

      const report = applyDesktopEnvFiles({
        appDirectory,
        env: {},
        isPackaged: false,
        userDataDirectory,
      });

      expect(report.failures).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain('sk-super-secret');
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('sk-super-secret');
    });

    it('is inert in test mode', () => {
      const { appDirectory, userDataDirectory } = makeDirs();
      fs.writeFileSync(path.join(appDirectory, '.env'), 'OPENAI_API_KEY=from-file\n');
      process.env['ELECTRON_IS_E2E_TEST'] = 'true';
      const env: NodeJS.ProcessEnv = {};

      const report = applyDesktopEnvFiles({
        appDirectory,
        env,
        isPackaged: false,
        userDataDirectory,
      });

      expect(env['OPENAI_API_KEY']).toBeUndefined();
      expect(report.skipped).toBe('test_mode');
      expect(report.appliedKeys).toEqual([]);
    });

    it('treats missing files as normal', () => {
      const { appDirectory, userDataDirectory } = makeDirs();

      const report = applyDesktopEnvFiles({
        appDirectory,
        env: {},
        isPackaged: false,
        userDataDirectory,
      });

      expect(report).toEqual(
        expect.objectContaining({ appliedKeys: [], failures: [], loadedFiles: [] })
      );
      expect(logger.error).not.toHaveBeenCalled();
    });
  });
});
