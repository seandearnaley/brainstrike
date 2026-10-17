import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { MockLanguageModelV4 } from 'ai/test';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { runHostCli } from '../src/cli.js';
import { attachAgentHost } from '../src/client.js';
import type { HostPlatform } from '../src/ports.js';
import { HOST_RESULT_SCHEMAS } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';
import { fixturePlatform } from './fixtures/child-run-host.js';

test('CLI ranked text preserves provenance, rejects unsupported scope/mode and joins cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m4-text-'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let joined = false;
  const calls: string[] = [];
  const platform: HostPlatform = {
    ...fixturePlatform(new MockLanguageModelV4()),
    searchWorkspace: async (request, signal) => {
      calls.push(request.mode);
      if (request.rootId !== 'selected') {
        // The desktop platform refuses a foreign root with a typed refusal.
        throw refusalError('authorization', 'workspace.root-unauthorized', 'Unauthorized root');
      }
      if (request.query === 'cancel') {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
        await release.promise;
        joined = true;
        signal.throwIfAborted();
      }
      return {
        candidateCount: 1,
        candidatesTruncated: false,
        hits: [
          {
            chunkId: 'chunk',
            content: 'recorded source text',
            endLine: 4,
            fileId: 'file',
            path: 'notes.md',
            rootId: 'selected',
            score: 1,
            startLine: 4,
          },
        ],
        scanLimited: false,
        storeId: 'store',
        truncated: false,
      };
    },
    validateWorkspaceBinding: async () => undefined,
  };
  const host = await startAgentHost({ lifetime: 'persistent', root }, platform);
  const client = await attachAgentHost(host.record);
  const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
  const cli = async (mode: string, rootId = 'selected') => {
    let output = '';
    await runHostCli(
      [
        '--data-root',
        root,
        'workspace',
        'search',
        '--thread',
        threadId,
        '--scope-root',
        rootId,
        '--mode',
        mode,
        '--query',
        'recorded',
      ],
      {
        write: (value) => {
          output += value;
        },
      }
    );
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['workspace/search'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(JSON.parse(output));
  };
  try {
    for (const mode of ['bm25', 'trigram']) {
      expect((await cli(mode)).hits[0]).toMatchObject({
        path: 'notes.md',
        rootId: 'selected',
        startLine: 4,
      });
    }
    await expect(cli('vector')).rejects.toThrow();
    expect(calls).toEqual(['bm25', 'trigram']);
    await expect(cli('bm25', 'foreign')).rejects.toThrow('Unauthorized root');
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { secondaryRootIds: ['secondary'] },
      threadId,
    });
    // The native host admits `selected`; the thread's narrower binding must refuse it first.
    const beforeOutOfScope = calls.length;
    await expect(cli('bm25', 'selected')).rejects.toThrow(
      'Search root is outside the thread workspace binding'
    );
    expect(calls).toHaveLength(beforeOutOfScope);
    await client.request('thread/workspace/binding/update', {
      commandId: randomUUID(),
      patch: { secondaryRootIds: ['selected'] },
      threadId,
    });
    expect((await cli('trigram')).hits[0]?.rootId).toBe('selected');
    const controller = new AbortController();
    const pending = client.request(
      'workspace/search',
      { limit: 20, mode: 'bm25', query: 'cancel', rootId: 'selected', threadId },
      controller.signal
    );
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    controller.abort();
    expect(joined).toBe(false);
    release.resolve();
    await rejected;
    expect(joined).toBe(true);
  } finally {
    release.resolve();
    await client.close();
    await host.close();
    await rm(root, { force: true, recursive: true });
  }
});
