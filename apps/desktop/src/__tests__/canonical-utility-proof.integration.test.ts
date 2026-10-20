// @vitest-environment node
import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { MAIN_PROCESS_BUILD_OPTIONS } from '../../scripts/build-main-config.mjs';
import {
  type CanonicalCollectionDependencies,
  CanonicalUtilityParent,
} from '../canonical-utility-parent';

interface ProofEvent {
  id: number;
  kind: string;
  ok?: boolean;
  op?: string;
  owner: string;
  phase: string;
  side: string;
}
function events(text: string): ProofEvent[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('[canonical-proof] '))
    .map((line) => JSON.parse(line.slice('[canonical-proof] '.length)));
}

it('correlates a held nested callback and its failure over real child IPC without logging payloads', async () => {
  vi.stubEnv('BRAINSTRIKE_PROOF_CANONICAL', '1');
  const writes = vi.spyOn(process.stderr, 'write');
  const fixture = await mkdtemp(path.resolve(import.meta.dirname, '../../.canonical-proof-'));
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let failed = false;
  const scope = { embeddingSetId: 'private-collection', kind: 'collection' as const };
  const dependencies: CanonicalCollectionDependencies = {
    catalog: {
      applyManagedCacheBatch: async () => {},
      completeFiles: async () => {},
      loadAuthorizedBatch: async () => [],
      prepareManagedSourcesBatch: async () => [],
      removeFiles: async () => {},
      resolveProfile: async () => {
        throw new Error('Unexpected inference');
      },
    },
    mode: 'TEXT',
    parser: { parser: 'oxc' },
    publication: {
      abortScan: async () => {},
      beginScan: async ({ requestId, scope }) => ({
        generation: 1,
        requestId,
        scope,
        storeId: 'private-store',
      }),
      commitTextFile: async () => {},
      finishScan: async ({ ticket, errors }) => ({
        reason: errors.length > 0 ? 'scan-errors' : 'complete',
        scanComplete: errors.length === 0,
        ticket,
      }),
      removeFile: async () => {},
      verifyManifest: async () => ({
        changed: [],
        complete: true,
        missing: [],
        storeId: 'private-store',
        unexpected: [],
      }),
    },
    request: { batchSize: 2, chunkingOptions: { strategy: 'auto' }, maxFileBytes: 1024 },
    scope,
    source: {
      indexingPolicyPreset: 'balanced',
      inventory: {
        loadFiles: async () => {
          entered.resolve();
          await released.promise;
          if (failed) {
            throw new Error('private-error-content');
          }
          return [];
        },
        readRetained: async () => {
          throw new Error('private-file-content');
        },
      },
    },
  };
  await build({
    ...MAIN_PROCESS_BUILD_OPTIONS,
    entryPoints: { 'channel-proof': 'src/__tests__/fixtures/canonical-channel-proof.ts' },
    logLevel: 'silent',
    outdir: fixture,
  });
  const child = fork(path.join(fixture, 'channel-proof.js'), [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const closed = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const transportFailure = Promise.withResolvers<never>();
  let closing = false;
  child.once('error', transportFailure.reject);
  child.once('exit', (code, signal) => {
    if (!closing) {
      transportFailure.reject(new Error(`Proof child exited ${code}/${signal}: ${stderr}`));
    }
  });
  const parent = new CanonicalUtilityParent(
    (frame) => child.send(frame),
    (error) => {
      throw error;
    }
  );
  child.on('message', (frame: unknown) => parent.receive(frame));
  let pending: Promise<unknown> | undefined;
  const parentEvents = () => events(writes.mock.calls.map(([chunk]) => String(chunk)).join(''));
  try {
    const attachment = await Promise.race([
      parent.attachCollection(dependencies),
      transportFailure.promise,
    ]);
    pending = attachment.scan('private-request-id').then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    await Promise.race([entered.promise, transportFailure.promise]);
    const started = parentEvents().find(
      (event) => event.phase === 'callback-start' && event.op === 'load-files'
    );
    expect(started).toBeDefined();
    if (!started) {
      throw new Error('Missing held callback proof');
    }
    expect(
      parentEvents().filter(
        (event) =>
          event.kind === 'result' &&
          event.phase === 'send' &&
          event.id === started?.id &&
          event.owner === started.owner
      )
    ).toEqual([]);
    released.resolve();
    await expect(pending).resolves.toMatchObject({ value: { scanComplete: true } });
    failed = true;
    await expect(attachment.scan('private-failure-request')).rejects.toThrow(
      'private-error-content'
    );
    await attachment.close();
    await parent.close();
    closing = true;
    child.disconnect();
    expect(await closed).toBe(0);
    const rows = [...parentEvents(), ...events(stderr)];
    const nested = rows.filter((row) => row.owner === started?.owner && row.id === started.id);
    expect(nested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'call', op: 'load-files', phase: 'send', side: 'child' }),
        expect.objectContaining({
          kind: 'call',
          op: 'load-files',
          phase: 'receive',
          side: 'parent',
        }),
        expect.objectContaining({ op: 'load-files', phase: 'callback-success', side: 'parent' }),
        expect.objectContaining({ kind: 'result', ok: true, phase: 'send', side: 'parent' }),
        expect.objectContaining({ kind: 'result', ok: true, phase: 'receive', side: 'child' }),
      ])
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ op: 'load-files', phase: 'callback-failure', side: 'parent' }),
        expect.objectContaining({ kind: 'result', ok: false, phase: 'send', side: 'parent' }),
        expect.objectContaining({ kind: 'result', ok: false, phase: 'receive', side: 'child' }),
      ])
    );
    const serialized = JSON.stringify(rows);
    for (const secret of [
      'private-collection',
      'private-store',
      'private-request-id',
      'private-failure-request',
      'private-error-content',
      'private-file-content',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  } finally {
    released.resolve();
    await pending;
    closing = true;
    if (child.connected) {
      await parent.close();
      child.disconnect();
    } else {
      await parent.exited(new Error('Proof transport already exited'));
    }
    await closed;
    writes.mockRestore();
    vi.unstubAllEnvs();
    await rm(fixture, { force: true, recursive: true });
  }
}, 20_000);
