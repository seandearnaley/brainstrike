import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProviders, providerEnvKeys } from '@brainstrike/assistant-contract/provider-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCredentialIsolatedChildEnvironment,
  type LoadDesktopEnvironmentOptions,
  loadDesktopEnvironment,
} from '../../desktop-env';
import { TAVILY_ENV_KEYS } from '../../tavily-env-keys';

const temporaryDirectories: string[] = [];

function createEnvironmentLayout(): { appRoot: string; userDataPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brainstrike-desktop-env-'));
  temporaryDirectories.push(root);
  const appRoot = path.join(root, 'app');
  const userDataPath = path.join(root, 'user-data');
  fs.mkdirSync(appRoot, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  return { appRoot, userDataPath };
}

function load(
  layout: { appRoot: string; userDataPath: string },
  overrides: Partial<LoadDesktopEnvironmentOptions> = {}
) {
  return loadDesktopEnvironment({
    ...layout,
    argv: [],
    env: {},
    isPackaged: false,
    ...overrides,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('createCredentialIsolatedChildEnvironment', () => {
  it('removes every registered credential name case-insensitively and preserves ordinary values', () => {
    const credentialNames = [
      ...listProviders().flatMap((definition) => [...providerEnvKeys(definition.id)]),
      ...TAVILY_ENV_KEYS,
    ];
    const source: NodeJS.ProcessEnv = Object.fromEntries(
      credentialNames.map((name) => [name, `secret-for-${name}`])
    );
    source['OpenAi_Api_Key'] = 'mixed-case-windows-secret';
    source['PATH'] = '/usr/bin';
    source['BRAINSTRIKE_HOOK_TEST_VALUE'] = 'ordinary-value';

    const result = createCredentialIsolatedChildEnvironment(source);

    expect(Object.keys(result).every((name) => !credentialNames.includes(name.toUpperCase()))).toBe(
      true
    );
    expect(result).toEqual({
      BRAINSTRIKE_HOOK_TEST_VALUE: 'ordinary-value',
      PATH: '/usr/bin',
    });
  });
});

describe('loadDesktopEnvironment', () => {
  it('applies existing env > .env.local > .env precedence in development', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env.local'),
      ['OPENAI_API_KEY=dev-local', 'ANTHROPIC_API_KEY=local'].join('\n')
    );
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      ['OPENAI_API_KEY=dev', 'GOOGLE_API_KEY=dev', 'OPENROUTER_API_KEY=base'].join('\n')
    );
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: 'inherited',
      TAVILY_API_KEY: '',
    };
    fs.appendFileSync(path.join(layout.appRoot, '.env.local'), '\nTAVILY_API_KEY=replacement');

    const result = load(layout, { env });

    expect(result).toEqual({
      appliedVariableCount: 3,
      failures: [],
      loadedFiles: ['dev-local', 'dev'],
      skipped: false,
    });
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'local',
      GOOGLE_API_KEY: 'dev',
      OPENAI_API_KEY: 'inherited',
      OPENROUTER_API_KEY: 'base',
      TAVILY_API_KEY: '',
    });
  });

  it('loads only userData/.env in a packaged launch', () => {
    const layout = createEnvironmentLayout();
    fs.mkdirSync(path.join(layout.appRoot, '.env.local'));
    fs.mkdirSync(path.join(layout.appRoot, '.env'));
    fs.writeFileSync(path.join(layout.userDataPath, '.env'), 'ANTHROPIC_API_KEY=user');
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env, isPackaged: true });

    expect(result).toEqual({
      appliedVariableCount: 1,
      failures: [],
      loadedFiles: ['user-data'],
      skipped: false,
    });
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'user' });
  });

  it('supports comments, export declarations, quoted values, and CRLF', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      [
        '\uFEFF# provider credentials',
        'export OPENAI_API_KEY="line-one\\nline-two"',
        "ANTHROPIC_API_KEY='literal # value'",
        'OPENROUTER_API_KEY=value # trailing comment',
        'GOOGLE_API_KEY=with=equals',
        'BRAINSTRIKE_TAVILY_API_KEY=`literal # backtick`',
      ].join('\r\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env, isPackaged: false });

    expect(result.failures).toEqual([]);
    expect(result.loadedFiles).toEqual(['dev']);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'literal # value',
      BRAINSTRIKE_TAVILY_API_KEY: 'literal # backtick',
      GOOGLE_API_KEY: 'with=equals',
      OPENAI_API_KEY: 'line-one\nline-two',
      OPENROUTER_API_KEY: 'value',
    });
  });

  it('treats a lone carriage return as a line terminator, never value content', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      'OPENAI_API_KEY=first\rANTHROPIC_API_KEY=second'
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.failures).toEqual([]);
    expect(env).toEqual({
      ANTHROPIC_API_KEY: 'second',
      OPENAI_API_KEY: 'first',
    });
  });

  it('does not inspect the user-data file for an unpackaged launch', () => {
    const layout = createEnvironmentLayout();
    fs.mkdirSync(path.join(layout.userDataPath, '.env'));
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env, isPackaged: false });

    expect(result).toEqual({
      appliedVariableCount: 0,
      failures: [],
      loadedFiles: [],
      skipped: false,
    });
    expect(env).toEqual({});
  });

  it('treats missing candidate files as a successful empty load', () => {
    const layout = createEnvironmentLayout();
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result).toEqual({
      appliedVariableCount: 0,
      failures: [],
      loadedFiles: [],
      skipped: false,
    });
    expect(env).toEqual({});
  });

  it('rejects all candidate files atomically when one file is malformed', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(path.join(layout.appRoot, '.env.local'), 'ANTHROPIC_API_KEY=local-secret');
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      ['OPENAI_API_KEY=base-secret', 'MALFORMED_LINE'].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.appliedVariableCount).toBe(0);
    expect(result.loadedFiles).toEqual([]);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([
      {
        code: 'env_file_invalid',
        file: 'dev',
        message: 'Desktop environment file "dev" is invalid at line 2: expected "=".',
      },
    ]);
    expect(env).toEqual({});
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('accepts every environment name the provider registry declares', () => {
    const layout = createEnvironmentLayout();
    const registryNames = listProviders().flatMap((definition) => [
      ...providerEnvKeys(definition.id),
    ]);
    expect(registryNames).toContain('BS_OPENAI_API_KEY');
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      registryNames.map((name) => `${name}=value`).join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.failures).toEqual([]);
    expect(Object.keys(env).sort()).toEqual([...new Set(registryNames)].sort());
  });

  it('rejects unsupported variables atomically instead of mutating the process environment', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      ['OPENAI_API_KEY=provider-secret', 'NODE_OPTIONS=--require ./inject.cjs'].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result).toEqual({
      appliedVariableCount: 0,
      failures: [
        {
          code: 'env_file_invalid',
          file: 'dev',
          message:
            'Desktop environment file "dev" is invalid at line 2: unsupported variable name.',
        },
      ],
      loadedFiles: [],
      skipped: false,
    });
    expect(env).toEqual({});
    expect(JSON.stringify(result)).not.toContain('NODE_OPTIONS');
  });

  it.each(['NODE_ENV=test', 'ELECTRON_IS_E2E_TEST=true', 'PATH=/tmp/evil', 'HTTPS_PROXY=http://x'])(
    'rejects the whole file when it sets %s',
    (assignment) => {
      const layout = createEnvironmentLayout();
      fs.writeFileSync(
        path.join(layout.appRoot, '.env'),
        ['OPENAI_API_KEY=provider-secret', assignment].join('\n')
      );
      const env: NodeJS.ProcessEnv = {};

      const result = load(layout, { env });

      expect(result.appliedVariableCount).toBe(0);
      expect(result.failures).toEqual([
        {
          code: 'env_file_invalid',
          file: 'dev',
          message:
            'Desktop environment file "dev" is invalid at line 2: unsupported variable name.',
        },
      ]);
      expect(env).toEqual({});
    }
  );

  it.each([
    ['leading assignment whitespace', ' OPENAI_API_KEY=provider-secret'],
    ['whitespace before the value', 'OPENAI_API_KEY= provider-secret'],
    ['trailing unquoted whitespace', 'OPENAI_API_KEY=provider-secret '],
    ['trailing quoted whitespace', 'OPENAI_API_KEY="provider-secret" '],
  ])('rejects %s instead of silently changing the value', (_label, source) => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(path.join(layout.appRoot, '.env'), source);
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.appliedVariableCount).toBe(0);
    expect(result.failures).toEqual([
      {
        code: 'env_file_invalid',
        file: 'dev',
        message: 'Desktop environment file "dev" is invalid at line 1: boundary whitespace.',
      },
    ]);
    expect(env).toEqual({});
    expect(JSON.stringify(result)).not.toContain('provider-secret');
  });

  it('rejects unterminated quotes without exposing the value', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(path.join(layout.appRoot, '.env.local'), 'OPENAI_API_KEY="super-secret-value');

    const result = load(layout);

    expect(result.failures).toEqual([
      {
        code: 'env_file_invalid',
        file: 'dev-local',
        message: 'Desktop environment file "dev-local" is invalid at line 1: unterminated quote.',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('surfaces unreadable candidates without exposing their paths', () => {
    const layout = createEnvironmentLayout();
    const unreadablePath = path.join(layout.appRoot, '.env.local');
    fs.mkdirSync(unreadablePath);

    const result = load(layout);

    expect(result.failures).toEqual([
      {
        code: 'env_file_unreadable',
        file: 'dev-local',
        message: 'Desktop environment file "dev-local" could not be read.',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(unreadablePath);
  });

  it.each([
    {
      label: 'NODE_ENV=test',
      options: { argv: [], env: { NODE_ENV: 'test' } },
    },
    {
      label: 'ELECTRON_IS_E2E_TEST=true',
      options: { argv: [], env: { ELECTRON_IS_E2E_TEST: 'true' } },
    },
    {
      label: '--test-mode',
      options: { argv: ['electron', '.', '--test-mode'], env: {} },
    },
  ])('performs no file reads or mutations in $label mode', ({ options }) => {
    const layout = createEnvironmentLayout();
    fs.mkdirSync(path.join(layout.appRoot, '.env.local'));
    const env: NodeJS.ProcessEnv = { ...options.env };

    const result = load(layout, { argv: options.argv, env });

    expect(result).toEqual({
      appliedVariableCount: 0,
      failures: [],
      loadedFiles: [],
      skipped: true,
    });
    expect(env).toEqual(options.env);
  });
});
