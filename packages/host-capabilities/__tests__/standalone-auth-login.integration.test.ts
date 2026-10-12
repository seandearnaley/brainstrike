import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivateCredentialFile } from '@brainstrike/agent-host/file-credentials';
import { removeFixtureRoot } from '@brainstrike/agent-host/test-fixtures/cooperative-host';
import { processStartTime, RootLock } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const roots: string[] = [];

interface CliResult {
  readonly argv: readonly string[];
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs the real bin with `stdin` piped in, the only channel a secret may use. */
function login(dataRoot: string, args: readonly string[], stdin: string): Promise<CliResult> {
  const argv = [
    bin,
    '--data-root',
    dataRoot,
    '--credential-store',
    'file',
    '--credential-file',
    join(dataRoot, 'credentials.json'),
    'auth',
    'login',
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd: tmpdir(),
      env: { LC_ALL: 'C', PATH: process.env['PATH'], SystemRoot: process.env['SystemRoot'] },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ argv, code, stderr, stdout }));
    child.stdin.end(stdin);
  });
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-auth-login-'));
  roots.push(value);
  return value;
}

async function storedSecrets(dataRoot: string): Promise<Record<string, string>> {
  const content = await readPrivateCredentialFile(join(dataRoot, 'credentials.json'));
  return content === undefined ? {} : JSON.parse(content).secrets;
}

async function expectRootReleased(dataRoot: string): Promise<void> {
  const owner = RootLock.inspect(dataRoot)?.owner;
  if (owner) {
    await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
    await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  }
}

afterEach(async () => {
  for (const dataRoot of roots.splice(0)) {
    await expectRootReleased(dataRoot);
    await removeFixtureRoot(dataRoot);
  }
});

test('auth login stores an API key read from stdin in the host credential store', async () => {
  const dataRoot = await root();
  const secret = 'sk-login-fixture-stdin-only';
  const result = await login(dataRoot, ['--provider', 'openai'], `${secret}\n`);
  expect(result).toMatchObject({ code: 0, stderr: '', stdout: '{"stored":true}\n' });
  expect(result.argv.join(' ')).not.toContain(secret);
  expect(await storedSecrets(dataRoot)).toEqual({
    openai: JSON.stringify({ key: secret, type: 'api_key' }),
  });
});

test('auth login stores an AWS bearer key for an AWS provider', async () => {
  const dataRoot = await root();
  const result = await login(
    dataRoot,
    ['--provider', 'bedrock', '--region', 'us-east-1'],
    'bedrock-bearer-fixture\n'
  );
  expect(result).toMatchObject({ code: 0, stdout: '{"stored":true}\n' });
  expect(JSON.parse((await storedSecrets(dataRoot))['bedrock'] ?? 'null')).toEqual({
    bearerKey: 'bedrock-bearer-fixture',
    mode: 'bearer',
    region: 'us-east-1',
    type: 'aws',
  });
});

test('empty stdin refuses before any host starts', async () => {
  const dataRoot = await root();
  const result = await login(dataRoot, ['--provider', 'openai'], '');
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('stdin');
  expect(RootLock.inspect(dataRoot)).toBeNull();
});

test('the ChatGPT subscription provider has no CLI credential login', async () => {
  const dataRoot = await root();
  const result = await login(dataRoot, ['--provider', 'openai-codex'], 'not-a-subscription\n');
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('does not accept a credential login');
  expect(await storedSecrets(dataRoot)).toEqual({});
});
