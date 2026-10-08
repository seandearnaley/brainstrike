import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHostRecord, type HostRecord } from '@brainstrike/host-lease';
import { processStartTime, RootLock, StateStore } from '@brainstrike/state-store';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { attachAgentHost } from '../src/client.js';
import { HOST_RESULT_SCHEMAS } from '../src/protocol.js';
import { removeFixtureRoot } from './fixtures/cooperative-host-fixture.js';

const bin = fileURLToPath(new URL('../bin/brainstrike.mjs', import.meta.url));
const roots: string[] = [];
const httpFixture = fileURLToPath(
  new URL('./fixtures/standalone-production-http.mjs', import.meta.url)
);

interface CliResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface OfflineHttp {
  readonly credential?: 'env' | 'file' | 'keyring';
  readonly mode: 'complete' | 'hold';
  readonly receipt: string;
}

function command(root: string, args: readonly string[], http?: OfflineHttp): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [bin, '--data-root', root, ...args],
      {
        cwd: tmpdir(),
        env: {
          LC_ALL: 'C',
          PATH: process.env['PATH'],
          SystemRoot: process.env['SystemRoot'],
          TZ: 'UTC',
          ...(http
            ? {
                BRAINSTRIKE_M3_STANDALONE_CREDENTIAL: http.credential ?? 'env',
                BRAINSTRIKE_M3_STANDALONE_HTTP: http.mode,
                BRAINSTRIKE_M3_STANDALONE_RECEIPT: http.receipt,
                ...(http.credential === undefined || http.credential === 'env'
                  ? { BRAINSTRIKE_OPENAI_API_KEY: 'offline-standalone-fixture' }
                  : {}),
                NODE_OPTIONS: `--import=${httpFixture}`,
              }
            : {}),
        },
        timeout: 10_000,
        windowsHide: true,
      },
      (cause, stdout, stderr) => {
        if (!cause) {
          resolve({ code: 0, stderr, stdout });
        } else if (typeof cause.code === 'number') {
          resolve({ code: cause.code, stderr, stdout });
        } else {
          reject(cause);
        }
      }
    );
  });
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'bs-m3-standalone-production-'));
  roots.push(value);
  return value;
}

async function record(dataRoot: string): Promise<HostRecord> {
  return decodeHostRecord(JSON.parse(await readFile(join(dataRoot, 'host.json'), 'utf8')));
}

async function expectIdleHostJoined(dataRoot: string): Promise<void> {
  await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  const owner = RootLock.inspect(dataRoot)?.owner;
  expect(owner).toBeDefined();
  await expect.poll(() => processStartTime(owner?.pid ?? 0)).toBeNull();
}

afterEach(async () => {
  for (const dataRoot of roots.splice(0)) {
    const owner = RootLock.inspect(dataRoot)?.owner;
    if (owner && !owner.released) {
      expect(await command(dataRoot, ['host', 'stop'])).toMatchObject({ code: 0 });
      await expect.poll(() => processStartTime(owner.pid)).toBeNull();
    }
    await removeFixtureRoot(dataRoot);
  }
});

test('real bin lists a cold durable Root without a supplied platform and joins its idle owner', async () => {
  const dataRoot = await root();
  const result = await command(dataRoot, ['threads', 'list']);
  expect(result).toEqual({ code: 0, stderr: '', stdout: '{"threads":[]}\n' });
  await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  const owner = RootLock.inspect(dataRoot)?.owner;
  expect(owner).toBeDefined();
  await expect.poll(() => processStartTime(owner?.pid ?? 0)).toBeNull();
  await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const store = await StateStore.open(dataRoot);
  await store.close();
});

test('real bin attaches before platform selection, preserves threads and releases Root on authenticated stop', async () => {
  const dataRoot = await root();
  const started = await command(dataRoot, ['host', 'start']);
  expect(started.code).toBe(0);
  expect(started.stderr).toBe('');
  const first = await record(dataRoot);
  expect(HOST_RESULT_SCHEMAS.initialize.parse(JSON.parse(started.stdout))).toMatchObject({
    pid: first.pid,
    start: first.start,
  });
  const client = await attachAgentHost(first);
  try {
    await expect(attachAgentHost({ ...first, token: '00'.repeat(32) })).rejects.toThrow();
    expect(await client.request('thread/list', {})).toEqual({ threads: [] });
  } finally {
    await client.close();
  }
  const created = await command(dataRoot, ['thread', 'start']);
  expect(created.code).toBe(0);
  const { threadId } = HOST_RESULT_SCHEMAS['thread/start'].parse(JSON.parse(created.stdout));
  const shown = await command(dataRoot, ['threads', 'show', '--thread', threadId]);
  expect(shown.code).toBe(0);
  expect(shown.stderr).toBe('');
  expect(HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout)).rows).toEqual([
    expect.objectContaining({
      event: expect.objectContaining({ type: 'command.accepted' }),
      seq: 1,
      threadId,
    }),
    expect.objectContaining({
      event: expect.objectContaining({ type: 'thread.started' }),
      seq: 2,
      threadId,
    }),
  ]);
  // A supplied missing module cannot affect an already authenticated attachment.
  const attached = await command(dataRoot, [
    '--platform',
    join(dataRoot, 'absent.mjs'),
    'threads',
    'list',
  ]);
  expect(attached.code).toBe(0);
  expect(HOST_RESULT_SCHEMAS['thread/list'].parse(JSON.parse(attached.stdout))).toEqual({
    threads: [{ threadId }],
  });
  expect(await record(dataRoot)).toEqual(first);
  const stopped = await command(dataRoot, ['host', 'stop']);
  expect(stopped).toEqual({
    code: 0,
    stderr: '',
    stdout: '{"outcome":"stopped","rootReleased":true}\n',
  });
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  await expect.poll(() => processStartTime(first.pid)).toBeNull();
  await expect(access(join(dataRoot, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const reopened = await command(dataRoot, ['threads', 'list']);
  expect(reopened.code).toBe(0);
  expect(HOST_RESULT_SCHEMAS['thread/list'].parse(JSON.parse(reopened.stdout))).toEqual({
    threads: [{ threadId }],
  });
  await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});

test.each(['status', 'stop'] as const)(
  'cold host %s never starts the default platform',
  async (action) => {
    const dataRoot = await root();
    const result = await command(dataRoot, ['host', action]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No host is running for this root');
    expect(RootLock.inspect(dataRoot)).toBeNull();
  }
);

async function receipts(file: string) {
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)));
}

test('real bin runs the explicit canonical model through production HTTP, committed context and durable replay', async () => {
  const dataRoot = await root();
  const http: OfflineHttp = { mode: 'complete', receipt: join(dataRoot, 'offline-receipt.jsonl') };
  expect(await command(dataRoot, ['host', 'start'], http)).toMatchObject({ code: 0 });
  const owner = await record(dataRoot);
  const result = await command(
    dataRoot,
    [
      'run',
      'Synthetic standalone prompt',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ],
    http
  );
  expect(result.code).toBe(0);
  const output = result.stdout
    .trim()
    .split('\n')
    .map((line) => z.record(z.string(), z.json()).parse(JSON.parse(line)));
  const selected = z.object({ runId: z.string(), threadId: z.string() }).parse(output[0]);
  const shown = await command(dataRoot, ['threads', 'show', '--thread', selected.threadId], http);
  expect(shown.code).toBe(0);
  const { rows } = HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout));
  const started = rows.find((row) => row.event.type === 'run.started');
  expect(started?.event).toMatchObject({
    modelId: 'openai::gpt-6-sol',
    snapshot: {
      configuration: {
        capabilities: {
          configuredMcp: 'unavailable',
          nativeTools: 'unavailable',
          vectorMemory: 'unavailable',
        },
        intent: {
          agentLoop: { inputTokenLimit: 869_500 },
          modelConfiguration: { model: 'gpt-6-sol', provider: 'openai' },
        },
      },
      toolIdentities: {},
    },
  });
  expect(rows).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({
        outcome: 'completed',
        runId: selected.runId,
        type: 'run.finished',
      }),
    })
  );
  const preparedIndex = rows.findIndex((row) => row.event.type === 'provider.request.prepared');
  expect(preparedIndex).toBeGreaterThan(-1);
  const prepared = rows[preparedIndex]?.event;
  expect(prepared).toMatchObject({
    accounting: {
      measurement: { mode: 'declared-compatible-reference', tokenizer: 'o200k_base' },
      removedMessages: 0,
      usedBackstop: false,
    },
    modelId: 'gpt-6-sol',
    provider: 'openai',
    runId: selected.runId,
    type: 'provider.request.prepared',
  });
  const accounting = z
    .object({ promptTokens: z.number(), toolTokens: z.number(), totalTokens: z.number() })
    .parse(prepared?.type === 'provider.request.prepared' ? prepared.accounting : undefined);
  expect(accounting.promptTokens).toBeGreaterThan(0);
  expect(accounting.totalTokens).toBe(accounting.promptTokens + accounting.toolTokens);
  expect(accounting.totalTokens).toBeLessThan(869_500);
  expect(rows.findIndex((row) => row.event.type === 'model.step')).toBeGreaterThan(preparedIndex);
  expect(JSON.stringify(rows)).not.toContain('offline-standalone-fixture');
  const attached = await command(
    dataRoot,
    ['attach', '--thread', selected.threadId, '--json', '--non-interactive'],
    http
  );
  expect(attached.code).toBe(0);
  expect(attached.stdout).toContain('Offline standalone production reply');
  const beforeStop = await receipts(http.receipt);
  const requests = beforeStop.filter((item) => item['phase'] === 'provider-request');
  expect(requests).toHaveLength(1);
  expect(requests[0]?.['body']).toMatchObject({ model: 'gpt-6-sol', store: true, stream: true });
  expect(JSON.stringify(requests[0]?.['body'])).toContain('Synthetic standalone prompt');
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  const completed = await receipts(http.receipt);
  expect(completed.some((item) => item['phase'] === 'forbidden-capability')).toBe(false);
  for (const item of completed.filter((item) => item['phase'] === 'process-start')) {
    expect(item['electron']).toBeNull();
    expect(item['executable']).toBe(process.execPath);
  }
  expect(completed).toContainEqual(
    expect.objectContaining({ code: 0, phase: 'process-exit', pid: owner.pid })
  );
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  const reopened = await command(
    dataRoot,
    ['threads', 'show', '--thread', selected.threadId],
    http
  );
  expect(reopened.code).toBe(0);
  expect(HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(reopened.stdout)).rows).toEqual(rows);
  await expect.poll(() => RootLock.inspect(dataRoot)?.owner.released).toBe(true);
  const replayOwner = RootLock.inspect(dataRoot)?.owner;
  await expect.poll(() => processStartTime(replayOwner?.pid ?? 0)).toBeNull();
  expect(
    (await receipts(http.receipt)).filter((item) => item['phase'] === 'provider-request')
  ).toHaveLength(1);
});

test('real bin normalizes an explicitly selected private file through the existing credential authority', async () => {
  const dataRoot = await root();
  const credentialFile = join(dataRoot, 'synthetic-credentials.json');
  const content = JSON.stringify({
    records: {},
    secrets: { openai: JSON.stringify({ key: 'offline-standalone-fixture', type: 'api_key' }) },
    version: 1,
  });
  await writeFile(credentialFile, content, { mode: 0o600 });
  const selectedPath = `${dataRoot}/unused-subdirectory/../synthetic-credentials.json`;
  const http: OfflineHttp = {
    credential: 'file',
    mode: 'complete',
    receipt: join(dataRoot, 'offline-receipt.jsonl'),
  };
  expect(
    await command(
      dataRoot,
      ['host', 'start', '--credential-store', 'file', '--credential-file', selectedPath],
      http
    )
  ).toMatchObject({ code: 0 });
  const owner = await record(dataRoot);
  expect(
    await command(
      dataRoot,
      ['threads', 'list', '--credential-store', 'file', '--credential-file', credentialFile],
      http
    )
  ).toMatchObject({
    code: 1,
    stderr: expect.stringContaining('retains its existing credential authority'),
  });
  const result = await command(
    dataRoot,
    [
      'run',
      'Synthetic file credential request',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ],
    http
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Offline standalone production reply');
  expect(await readFile(credentialFile, 'utf8')).toBe(content);
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  const completed = await receipts(http.receipt);
  expect(completed.filter((item) => item['phase'] === 'provider-request')).toHaveLength(1);
  expect(completed.some((item) => item['phase'] === 'forbidden-capability')).toBe(false);
});

test('concurrent real bins retain the winning credential authority after a cold Root acquisition race', async () => {
  const dataRoot = await root();
  const credentialFile = join(dataRoot, 'synthetic-credentials.json');
  await writeFile(credentialFile, JSON.stringify({ records: {}, secrets: {}, version: 1 }), {
    mode: 0o600,
  });
  const http: OfflineHttp = {
    credential: 'file',
    mode: 'complete',
    receipt: join(dataRoot, 'offline-receipt.jsonl'),
  };
  const args = ['host', 'start', '--credential-store', 'file', '--credential-file', credentialFile];
  const results = await Promise.all([command(dataRoot, args, http), command(dataRoot, args, http)]);
  expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
  expect(results.find((result) => result.code === 1)?.stderr).toContain(
    'retains its existing credential authority'
  );
  const owner = await record(dataRoot);
  const winner = results.find((result) => result.code === 0);
  expect(HOST_RESULT_SCHEMAS.initialize.parse(JSON.parse(winner?.stdout ?? 'null')).pid).toBe(
    owner.pid
  );
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  expect((await receipts(http.receipt)).some((item) => item['phase'] === 'provider-request')).toBe(
    false
  );
});

test('real bin carries the explicit keyring service through its owned Node credential worker without OS access', async () => {
  const dataRoot = await root();
  const http: OfflineHttp = {
    credential: 'keyring',
    mode: 'complete',
    receipt: join(dataRoot, 'offline-receipt.jsonl'),
  };
  expect(
    await command(
      dataRoot,
      [
        'host',
        'start',
        '--credential-store',
        'keyring',
        '--credential-service',
        'brainstrike-standalone-fixture-service',
      ],
      http
    )
  ).toMatchObject({ code: 0 });
  const owner = await record(dataRoot);
  const result = await command(
    dataRoot,
    [
      'run',
      'Synthetic keyring worker request',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ],
    http
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Offline standalone production reply');
  const beforeStop = await receipts(http.receipt);
  expect(beforeStop).toContainEqual(
    expect.objectContaining({
      account: 'openai',
      options: { linux: { store: 'secret-service' } },
      phase: 'synthetic-keyring-entry',
      pid: owner.pid,
      service: 'brainstrike-standalone-fixture-service',
    })
  );
  const nativeWorker = beforeStop.find((item) => item['phase'] === 'synthetic-keyring-read');
  expect(nativeWorker?.['threadId']).toBeGreaterThan(0);
  expect(beforeStop.filter((item) => item['phase'] === 'provider-request')).toHaveLength(1);
  expect(beforeStop.some((item) => item['phase'] === 'forbidden-capability')).toBe(false);
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  expect(await receipts(http.receipt)).toContainEqual(
    expect.objectContaining({
      code: 0,
      phase: 'process-exit',
      pid: owner.pid,
      threadId: nativeWorker?.['threadId'],
    })
  );
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});

test('real bin refuses unsafe credential files and conflicting captured capabilities before HTTP', async () => {
  const dataRoot = await root();
  const credentialFile = join(dataRoot, 'unsafe-synthetic-credentials.json');
  await writeFile(credentialFile, JSON.stringify({ records: {}, secrets: {}, version: 1 }), {
    mode: 0o600,
  });
  await chmod(credentialFile, 0o644);
  const http: OfflineHttp = {
    credential: 'file',
    mode: 'complete',
    receipt: join(dataRoot, 'offline-receipt.jsonl'),
  };
  expect(
    await command(
      dataRoot,
      ['host', 'start', '--credential-store', 'file', '--credential-file', credentialFile],
      http
    )
  ).toMatchObject({ code: 0 });
  const owner = await record(dataRoot);
  const client = await attachAgentHost(owner);
  try {
    const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
    await expect(
      client.request('run/start', {
        commandId: randomUUID(),
        configuration: { enabledNativeToolIds: ['unexpected-native-tool'] },
        modelId: 'openai::gpt-6-sol',
        prompt: 'Rejected capability request',
        threadId,
      })
    ).rejects.toThrow('capabilities unavailable');
    await expect(
      client.request('run/start', {
        commandId: randomUUID(),
        modelId: 'openai::gpt-6-sol',
        prompt: 'Rejected unsafe credential request',
        threadId,
      })
    ).rejects.toThrow();
    const { rows } = await client.request('thread/read', { fromSeq: 0, threadId });
    expect(rows.some((row) => row.event.type === 'run.started')).toBe(false);
  } finally {
    await client.close();
  }
  expect((await receipts(http.receipt)).some((item) => item['phase'] === 'provider-request')).toBe(
    false
  );
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
});

test.each([
  ['unknown-provider::model', 'explicit canonical provider::model'],
  ['openai::not-in-canonical-catalog', 'canonical runtime catalog definition'],
  ['ollama::llama3.2', 'unavailable headless local-runtime capability'],
])('real bin explicitly rejects unavailable model selection %s', async (model, reason) => {
  const dataRoot = await root();
  const http: OfflineHttp = { mode: 'complete', receipt: join(dataRoot, 'offline-receipt.jsonl') };
  const result = await command(
    dataRoot,
    ['run', 'Rejected model request', '--model', model, '--json', '--non-interactive'],
    http
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(reason);
  expect((await receipts(http.receipt)).some((item) => item['phase'] === 'provider-request')).toBe(
    false
  );
  await expectIdleHostJoined(dataRoot);
});

test('real bin never guesses a credential service or silently falls back to a file', async () => {
  const dataRoot = await root();
  const http: OfflineHttp = {
    credential: 'file',
    mode: 'complete',
    receipt: join(dataRoot, 'offline-receipt.jsonl'),
  };
  const result = await command(
    dataRoot,
    [
      'run',
      'Missing credential authority request',
      '--model',
      'openai::gpt-6-sol',
      '--json',
      '--non-interactive',
    ],
    http
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('explicitly selected credential service');
  const completed = await receipts(http.receipt);
  expect(completed.some((item) => item['phase'] === 'provider-request')).toBe(false);
  expect(completed.some((item) => item['phase'] === 'forbidden-capability')).toBe(false);
  await expectIdleHostJoined(dataRoot);
});

test('real bin stop aborts and joins a held production HTTP source before host and Root release', async () => {
  const dataRoot = await root();
  const http: OfflineHttp = { mode: 'hold', receipt: join(dataRoot, 'offline-receipt.jsonl') };
  expect(await command(dataRoot, ['host', 'start'], http)).toMatchObject({ code: 0 });
  const owner = await record(dataRoot);
  const created = await command(dataRoot, ['thread', 'start'], http);
  expect(created.code).toBe(0);
  const { threadId } = HOST_RESULT_SCHEMAS['thread/start'].parse(JSON.parse(created.stdout));
  const running = await command(
    dataRoot,
    [
      'run',
      'start',
      '--thread',
      threadId,
      '--model',
      'openai::gpt-6-sol',
      '--prompt',
      'Synthetic held request',
    ],
    http
  );
  expect(running.code).toBe(0);
  const { runId } = HOST_RESULT_SCHEMAS['run/start'].parse(JSON.parse(running.stdout));
  await expect
    .poll(async () =>
      (await receipts(http.receipt)).some((item) => item['phase'] === 'provider-request')
    )
    .toBe(true);
  const stopped = await command(
    dataRoot,
    ['run', 'stop', '--thread', threadId, '--run', runId],
    http
  );
  expect(stopped.code).toBe(0);
  expect(HOST_RESULT_SCHEMAS['run/stop'].parse(JSON.parse(stopped.stdout))).toEqual({
    outcome: 'stopped',
  });
  expect(await receipts(http.receipt)).toContainEqual(
    expect.objectContaining({ phase: 'provider-aborted', pid: owner.pid })
  );
  const shown = await command(dataRoot, ['threads', 'show', '--thread', threadId], http);
  const { rows } = HOST_RESULT_SCHEMAS['thread/read'].parse(JSON.parse(shown.stdout));
  expect(rows).toContainEqual(
    expect.objectContaining({
      event: expect.objectContaining({ outcome: 'stopped', runId, type: 'run.finished' }),
    })
  );
  expect(await command(dataRoot, ['host', 'stop'], http)).toMatchObject({ code: 0 });
  await expect.poll(() => processStartTime(owner.pid)).toBeNull();
  expect(RootLock.inspect(dataRoot)?.owner.released).toBe(true);
});
