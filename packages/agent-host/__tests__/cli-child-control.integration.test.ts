import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RootLock } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { Schema } from 'effect';
import { expect, test } from 'vitest';
import { runHostCli } from '../src/cli.js';
import { HOST_RESULT_SCHEMAS, type HostLogRow } from '../src/protocol.js';
import { startAgentHost } from '../src/runtime.js';
import {
  blocked,
  fixturePlatform,
  stream,
  text,
  toolCall,
  toolCalls,
  toolNames,
  userTexts,
} from './fixtures/child-run-host.js';

const started = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.started' ? [event] : []));
const finished = (rows: readonly HostLogRow[]) =>
  rows.flatMap(({ event }) => (event.type === 'run.finished' ? [event] : []));
test('named CLI child controls queue input, stop only its sibling, and continue the idle child', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-m4-cli-child-'));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = new MockLanguageModelV4({
    doStream: async (call) => {
      const users = userTexts(call);
      if (toolNames(call).includes('agent-explore')) {
        return call.prompt.some((message) => message.role === 'tool')
          ? stream(text('Parent read the children.'))
          : stream(
              toolCalls([
                ['agent-explore', { prompt: 'ALPHA' }, 'alpha'],
                ['agent-explore', { prompt: 'BETA' }, 'beta'],
              ])
            );
      }
      if (users[0] === 'BETA') {
        return blocked(call);
      }
      if (users.at(-1) === 'INPUT' || users.at(-1) === 'FOLLOWUP') {
        return stream(text(`Child received ${users.at(-1)}.`));
      }
      return stream(toolCall('read_file', { path: 'notes.md' }, 'read-alpha'));
    },
  });
  const host = await startAgentHost(
    { lifetime: 'persistent', root },
    fixturePlatform(model, [], {
      readFile: async () => {
        entered.resolve();
        await release.promise;
        return { content: 'notes' };
      },
    })
  );
  const cli = async (args: readonly string[]): Promise<unknown> => {
    let output = '';
    await runHostCli(['--data-root', root, ...args], {
      write: (value) => {
        output += value;
      },
    });
    return JSON.parse(output);
  };
  try {
    const { threadId } = await host.core.startThread({ commandId: randomUUID() });
    await host.core.startRun({
      commandId: randomUUID(),
      modelId: 'scripted',
      prompt: 'Delegate.',
      threadId,
    });
    await entered.promise;
    const { children } = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/children'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(await cli(['children', 'list', '--thread', threadId]));
    expect(children).toHaveLength(2);
    const tasks = await Promise.all(
      children.map(async (child) => ({
        ...child,
        run: started(await host.core.read(child.threadId, 0))[0],
      }))
    );
    const alpha = tasks.find(({ run }) => run?.prompt === 'ALPHA');
    const beta = tasks.find(({ run }) => run?.prompt === 'BETA');
    if (!(alpha?.run && beta?.run)) {
      throw new Error('Both delegated run identities must be committed');
    }
    for (const command of ['send', 'input', 'stop']) {
      await expect(
        cli([
          'child',
          command,
          '--thread',
          threadId,
          '--run',
          alpha.run.runId,
          '--model',
          'scripted',
          '--prompt',
          'WRONG ROOT',
        ])
      ).rejects.toThrow('requires a child thread');
    }
    expect(
      await cli([
        'child',
        'input',
        '--thread',
        alpha.threadId,
        '--run',
        alpha.run.runId,
        '--model',
        'scripted',
        '--prompt',
        'INPUT',
      ])
    ).toEqual({ accepted: true });
    expect(
      await cli(['child', 'stop', '--thread', beta.threadId, '--run', beta.run.runId])
    ).toEqual({ outcome: 'stopped' });
    expect(finished(await host.core.read(alpha.threadId, 0))).toEqual([]);
    release.resolve();
    await expect
      .poll(async () =>
        finished(await host.core.read(alpha.threadId, 0)).map(({ outcome }) => outcome)
      )
      .toEqual(['completed', 'completed']);
    expect(started(await host.core.read(alpha.threadId, 0)).map(({ prompt }) => prompt)).toEqual([
      'ALPHA',
      'INPUT',
    ]);
    await expect
      .poll(async () =>
        started(await host.core.read(threadId, 0))
          .flatMap(({ delivery }) => delivery?.entries ?? [])
          .filter(({ childThreadId }) => childThreadId === alpha.threadId)
      )
      .toHaveLength(2);
    const inputBatch = started(await host.core.read(threadId, 0)).filter(({ delivery }) =>
      delivery?.entries.some(({ childThreadId }) => childThreadId === alpha.threadId)
    );
    expect(inputBatch).toHaveLength(1);
    expect(
      inputBatch[0]?.delivery?.entries
        .filter(({ childThreadId }) => childThreadId === alpha.threadId)
        .map(({ childRunId }) => childRunId)
        .sort()
    ).toEqual(
      started(await host.core.read(alpha.threadId, 0))
        .map(({ runId }) => runId)
        .sort()
    );
    const sent = Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['run/start'], {
      errors: 'all',
      onExcessProperty: 'error',
    })(
      await cli([
        'child',
        'send',
        '--thread',
        alpha.threadId,
        '--model',
        'scripted',
        '--prompt',
        'FOLLOWUP',
      ])
    );
    await expect
      .poll(
        async () =>
          finished(await host.core.read(alpha.threadId, 0)).find(
            ({ runId }) => runId === sent.runId
          )?.outcome
      )
      .toBe('completed');
    await expect
      .poll(async () =>
        started(await host.core.read(threadId, 0))
          .flatMap(({ delivery }) => delivery?.entries ?? [])
          .filter(({ childThreadId }) => childThreadId === alpha.threadId)
      )
      .toHaveLength(3);
    expect(finished(await host.core.read(beta.threadId, 0)).map(({ outcome }) => outcome)).toEqual([
      'stopped',
    ]);
    expect(started(await host.core.read(alpha.threadId, 0)).map(({ prompt }) => prompt)).toEqual([
      'ALPHA',
      'INPUT',
      'FOLLOWUP',
    ]);
  } finally {
    release.resolve();
    await host.close();
    expect(RootLock.inspect(root)?.owner.released).toBe(true);
    await rm(root, { recursive: true });
  }
});
