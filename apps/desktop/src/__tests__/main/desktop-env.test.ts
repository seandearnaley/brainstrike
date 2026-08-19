import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listProviders,
  providerDeprecatedEnvKeys,
  providerEnvKeys,
} from '@brainstrike/assistant-contract/provider-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ENV_FILE_VARIABLE_NAMES,
  createCredentialIsolatedChildEnvironment,
  type LoadDesktopEnvironmentOptions,
  loadDesktopEnvironment,
  NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES,
  SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES,
  SUPPORTED_ENV_FILE_VARIABLE_NAMES,
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
      ...listProviders().flatMap((definition) => [
        ...providerEnvKeys(definition.id),
        ...providerDeprecatedEnvKeys(definition.id),
      ]),
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

  it('scrubs both Bedrock bearer names (registry-derived, pinned by name — BST-1350)', () => {
    // Explicit pin on top of the derived loop above: the two Bedrock env
    // names are credential-shaped and must never reach children.
    const result = createCredentialIsolatedChildEnvironment({
      AWS_BEARER_TOKEN_BEDROCK: 'bearer-secret',
      BRAINSTRIKE_BEDROCK_API_KEY: 'override-secret',
      PATH: '/usr/bin',
    });
    expect(result).toEqual({ PATH: '/usr/bin' });
    expect(CREDENTIAL_ENV_FILE_VARIABLE_NAMES.has('AWS_BEARER_TOKEN_BEDROCK')).toBe(true);
    expect(CREDENTIAL_ENV_FILE_VARIABLE_NAMES.has('BRAINSTRIKE_BEDROCK_API_KEY')).toBe(true);
  });

  it('keeps AWS_REGION and AWS_PROFILE for children — configuration, not secrets (BST-1350/1353)', () => {
    const result = createCredentialIsolatedChildEnvironment({
      AWS_BEARER_TOKEN_BEDROCK: 'bearer-secret',
      AWS_PROFILE: 'acme-dev',
      AWS_REGION: 'us-east-1',
      PATH: '/usr/bin',
    });
    // AWS_PROFILE NAMES a profile; the credentials it points at live in the
    // user's AWS config and never pass through this process env, so scrubbing
    // the name would break `aws` CLI children while protecting nothing.
    expect(result).toEqual({
      AWS_PROFILE: 'acme-dev',
      AWS_REGION: 'us-east-1',
      PATH: '/usr/bin',
    });
    expect(CREDENTIAL_ENV_FILE_VARIABLE_NAMES.has('AWS_REGION')).toBe(false);
    expect(CREDENTIAL_ENV_FILE_VARIABLE_NAMES.has('AWS_PROFILE')).toBe(false);
    // The non-credential set stays deliberately tiny — extend it only with a
    // ruling, never casually.
    expect([...NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES].sort()).toEqual([
      'AWS_PROFILE',
      'AWS_REGION',
    ]);
  });

  it('SECURITY: AWS static keys never reach a child environment (PR #2525 review, finding 1)', () => {
    // THE OUTCOME, not set membership. The scrub is a DENY-LIST: any name
    // absent from the scrubbed set passes through VERBATIM to
    // repository-controlled children (execute-command-tool, the hook
    // executor). Since BST-1353 documents shell-set AWS static keys as a
    // supported way to activate the credential chain, leaving them out of the
    // deny-list was a live credential-leak path — "in neither set" is NOT the
    // same as "protected".
    const child = createCredentialIsolatedChildEnvironment({
      AWS_ACCESS_KEY_ID: 'AKIALEAK',
      AWS_PROFILE: 'acme-dev',
      AWS_REGION: 'us-east-1',
      AWS_SECRET_ACCESS_KEY: 'leaked-secret',
      AWS_SESSION_TOKEN: 'leaked-session',
      PATH: '/usr/bin',
    });

    expect(child['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['AWS_SESSION_TOKEN']).toBeUndefined();
    expect(Object.values(child)).not.toContain('leaked-secret');
    expect(Object.values(child)).not.toContain('leaked-session');
    // The two NON-secret names still pass through: a child may legitimately
    // need the region, and AWS_PROFILE only NAMES a profile.
    expect(child['AWS_REGION']).toBe('us-east-1');
    expect(child['AWS_PROFILE']).toBe('acme-dev');
    expect(child['PATH']).toBe('/usr/bin');
  });

  it('SECURITY: AWS static keys are SCRUBBED but never `.env`-file loadable', () => {
    // The two roles are now separate constants (SCRUBBED ⊇ ENV_FILE). Adding
    // these names to the scrub must NOT make them settable from a `.env`
    // file — that would hand a userData file write a new credential channel.
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      expect(SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES.has(name)).toBe(true);
      expect(CREDENTIAL_ENV_FILE_VARIABLE_NAMES.has(name)).toBe(false);
      expect(NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES.has(name)).toBe(false);
      expect(SUPPORTED_ENV_FILE_VARIABLE_NAMES.has(name)).toBe(false);
    }
  });

  it('SECURITY: the scrubbed set is a SUPERSET of the env-file credential set', () => {
    // A name that a `.env` file may set is by definition credential-shaped
    // enough to scrub; the reverse need not hold.
    for (const name of CREDENTIAL_ENV_FILE_VARIABLE_NAMES) {
      expect(SCRUBBED_CREDENTIAL_ENV_VARIABLE_NAMES.has(name)).toBe(true);
    }
  });

  it('SECURITY: the non-credential set contains ONLY non-secret configuration', () => {
    // A tripwire on the whole set rather than on the names BST-1353 happened
    // to add: anything that looks like a secret must never land here.
    for (const name of NON_CREDENTIAL_SUPPORTED_ENV_FILE_VARIABLE_NAMES) {
      expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/);
    }
  });
});

describe('loadDesktopEnvironment', () => {
  it('accepts AWS_REGION from env files as a supported non-credential name (BST-1350)', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      ['AWS_BEARER_TOKEN_BEDROCK=bearer', 'AWS_REGION=us-east-1'].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.failures).toEqual([]);
    expect(result.appliedVariableCount).toBe(2);
    expect(env).toMatchObject({
      AWS_BEARER_TOKEN_BEDROCK: 'bearer',
      AWS_REGION: 'us-east-1',
    });
  });

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
      deprecatedVariableNames: ['GOOGLE_API_KEY'],
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
      deprecatedVariableNames: [],
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
      deprecatedVariableNames: [],
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
      deprecatedVariableNames: [],
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
        message: 'Desktop environment file ".env" is invalid at line 2: expected "=".',
      },
    ]);
    expect(env).toEqual({});
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('accepts every environment name the provider registry declares, deprecated included', () => {
    const layout = createEnvironmentLayout();
    const registryNames = listProviders().flatMap((definition) => [
      ...providerEnvKeys(definition.id),
      ...providerDeprecatedEnvKeys(definition.id),
    ]);
    expect(registryNames).toContain('BS_OPENAI_API_KEY');
    expect(registryNames).toContain('BRAINSTRIKE_ANTHROPIC_API_KEY');
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      registryNames.map((name) => `${name}=value`).join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    expect(result.failures).toEqual([]);
    expect(Object.keys(env).sort()).toEqual([...new Set(registryNames)].sort());
  });

  it('loads a file containing a deprecated name and reports the name (BST-1361)', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(
      path.join(layout.appRoot, '.env'),
      ['OPENAI_API_KEY_V2=legacy-secret', 'ANTHROPIC_API_KEY=current'].join('\n')
    );
    const env: NodeJS.ProcessEnv = {};

    const result = load(layout, { env });

    // The file is NOT rejected: a deprecated name parses fine.
    expect(result.failures).toEqual([]);
    expect(result.loadedFiles).toEqual(['dev']);
    expect(result.appliedVariableCount).toBe(2);
    expect(result.deprecatedVariableNames).toEqual(['OPENAI_API_KEY_V2']);
    // Names only — the value must never ride the load result.
    expect(JSON.stringify(result)).not.toContain('legacy-secret');
    expect(env['OPENAI_API_KEY_V2']).toBe('legacy-secret');
  });

  it('reports deprecated names present in files even when the process env already wins', () => {
    const layout = createEnvironmentLayout();
    fs.writeFileSync(path.join(layout.appRoot, '.env'), 'GOOGLE_API_KEY=file-value');
    const env: NodeJS.ProcessEnv = { GOOGLE_API_KEY: 'inherited' };

    const result = load(layout, { env });

    expect(result.appliedVariableCount).toBe(0);
    expect(result.deprecatedVariableNames).toEqual(['GOOGLE_API_KEY']);
    expect(env['GOOGLE_API_KEY']).toBe('inherited');
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
      deprecatedVariableNames: [],
      failures: [
        {
          code: 'env_file_invalid',
          file: 'dev',
          message:
            'Desktop environment file ".env" is invalid at line 2: unsupported variable name.',
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
            'Desktop environment file ".env" is invalid at line 2: unsupported variable name.',
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
        message: 'Desktop environment file ".env" is invalid at line 1: boundary whitespace.',
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
        message: 'Desktop environment file ".env.local" is invalid at line 1: unterminated quote.',
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
        message: 'Desktop environment file ".env.local" could not be read.',
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
      deprecatedVariableNames: [],
      failures: [],
      loadedFiles: [],
      skipped: true,
    });
    expect(env).toEqual(options.env);
  });
});
