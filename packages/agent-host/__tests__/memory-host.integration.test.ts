import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { StateStore } from '@brainstrike/state-store';
import { MessageList } from '@mastra/core/agent';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { committedMemoryTranscript } from '../src/adapters/committed-memory-transcript.js';
import { StateStoreHostMemory } from '../src/adapters/state-store-host-memory.js';
import { committedRowAddress, committedRunIdentity } from '../src/committed-identities.js';
import { HostCore } from '../src/core.js';
import { readHostRow } from '../src/event-storage.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { scriptedToolSequence } from './fixtures/scripted-model.js';

/**
 * The first matching row Core commits after this call. Subscribe before the
 * command that causes it: the wait ends on the run's own committed signal,
 * however long a loaded machine takes to admit the run, never on a clock.
 */
function nextCommitted(core: HostCore, match: (row: HostLogRow) => boolean): Promise<HostLogRow> {
  const committed = Promise.withResolvers<HostLogRow>();
  const unsubscribe = core.onCommitted((row) => {
    if (match(row)) {
      unsubscribe();
      committed.resolve(row);
    }
  });
  return committed.promise;
}

test.each([
  ['history', 3],
  ['history', 40],
  ['OM', 3],
] as const)(
  'existing SQLite writer composes public Memory with real approval, file effect and canonical replay (%s, window %i)',
  async (mode, lastMessages) => {
    const root = await mkdtemp(join(tmpdir(), 'bs-m3-memory-host-'));
    const target = join(root, 'permitted.txt');
    const resourceId = randomUUID();
    const writerOptions = {
      memoryCalculatorModule: fileURLToPath(
        new URL('../dist/adapters/memory-storage-calculator.js', import.meta.url)
      ),
    };
    let store = await StateStore.open(root, writerOptions);
    const owners: StateStoreHostMemory[] = [];
    const receipts: { readonly kind: 'observation' | 'reflection'; readonly modelId: string }[] =
      [];
    const prepared: unknown[] = [];
    const hostPreparedMessages: unknown[] = [];
    const admissions: { readonly runId: string; readonly startedAt: number; readyAt?: number }[] =
      [];
    const observer = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: null,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { id: 'observation-text', type: 'text-start' },
            {
              delta: '<observations>\n- The user asked about Paris weather.\n</observations>',
              id: 'observation-text',
              type: 'text-delta',
            },
            { id: 'observation-text', type: 'text-end' },
            {
              finishReason: { raw: 'stop', unified: 'stop' },
              type: 'finish',
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 42, total: 42 },
                outputTokens: { reasoning: 0, text: 9, total: 9 },
              },
            },
          ],
          initialDelayInMs: null,
        }),
      }),
    });
    const model = scriptedToolSequence([
      { input: { text: 'recorded permitted payload' }, toolId: 'writeArtifact' },
    ]);
    let executions = 0;
    const platform: HostPlatform = {
      close: async () => undefined,
      maxSteps: 3,
      openRun: async (context) => {
        const admission: (typeof admissions)[number] = {
          runId: context.runId,
          startedAt: performance.now(),
        };
        admissions.push(admission);
        const owner = await StateStoreHostMemory.open(context, {
          native: {
            options: {
              lastMessages,
              observationalMemory:
                mode === 'OM'
                  ? {
                      model: observer,
                      observation: { bufferOnIdle: false, bufferTokens: false, messageTokens: 30 },
                      reflection: { observationTokens: 50_000 },
                    }
                  : false,
              semanticRecall: false,
              workingMemory: { enabled: true, scope: 'thread' },
            },
          },
          observerModelId: 'openai::gpt-4.1-mini',
          providerRequestContext: () => ({ inputTokenLimit: 30_000, provider: 'openai' }),
          recordObserverUsage: async (_identity, receipt) => {
            receipts.push(receipt);
          },
          recordPrompt: async (_identity, request) => {
            prepared.push(request);
          },
          resourceId,
          store,
        });
        admission.readyAt = performance.now();
        owners.push(owner);
        return owner;
      },
      readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
      resolveModel: async () => model,
      tools: {
        writeArtifact: {
          description: 'Write the actual recorded payload to the isolated fixture file.',
          execute: async (input, context) => {
            context.signal.throwIfAborted();
            const value = z.object({ text: z.string() }).parse(input);
            await writeFile(target, value.text);
            executions += 1;
            return { written: true };
          },
          identity: 'recorded-native-writer',
          inputSchema: z.object({ text: z.string() }),
          risk: 'edit',
        },
      },
    };
    const providerSystem = 'host-context-fixture:72a4bd96';
    platform.admitRun = async () => {
      const tools = platform.tools;
      if (!tools) {
        throw new Error('The recorded native catalog is missing');
      }
      return {
        configuration: {},
        model,
        provider: {
          prepare: async ({ messages }) => {
            hostPreparedMessages.push(structuredClone(messages));
            return { messages: [...messages], model, system: providerSystem };
          },
        },
        snapshot: {
          configuration: { system: providerSystem },
          maxSteps: 3,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [name, tool.identity])
          ),
        },
        tools,
      };
    };
    let core = await HostCore.open(store, platform, () => () => undefined);
    let failure: unknown;
    try {
      const { threadId } = await core.startThread({ commandId: randomUUID() });
      const command = {
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: mode === 'OM' ? 'Paris weather. '.repeat(60) : 'Perform recorded write',
        threadId,
      };
      const firstPause = nextCommitted(
        core,
        (row) =>
          row.threadId === threadId &&
          (row.event.type === 'interaction.requested' || row.event.type === 'run.finished')
      );
      const { runId } = await core.startRun(command);
      expect((await firstPause).event.type).toBe('interaction.requested');
      const before = await core.read(threadId, 0);
      const beforeTranscript = committedMemoryTranscript(before, resourceId);
      const pending = before.find((row) => row.event.type === 'interaction.requested')?.event;
      if (pending?.type !== 'interaction.requested') {
        throw new Error('Actual Memory-composed host did not commit approval');
      }
      const owner = owners[0];
      if (!owner) {
        throw new Error('Host did not acquire public Memory');
      }
      const workingMemory = JSON.stringify({ fixture: 'retained working memory', resourceId });
      await owner.memory.updateWorkingMemory(workingMemory);
      expect(await owner.memory.getWorkingMemory()).toBe(workingMemory);
      expect(await core.startRun(command)).toEqual({ runId });
      expect(owners).toHaveLength(1);
      const firstFinished = nextCommitted(
        core,
        (row) => row.event.type === 'run.finished' && row.event.runId === runId
      );
      await core.respond({
        commandId: randomUUID(),
        decision: 'approve',
        interactionId: pending.interactionId,
        runId,
        threadId,
      });
      expect((await firstFinished).event).toMatchObject({ outcome: 'completed' });
      expect(executions).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('recorded permitted payload');
      const committed = await core.read(threadId, 0);
      expect(
        committed.filter((row) => row.event.type === 'provider.request.prepared')
      ).toHaveLength(model.doStreamCalls.length);
      expect(prepared).toEqual(model.doStreamCalls);
      const systemContext = JSON.stringify(
        model.doStreamCalls.at(-1)?.prompt.filter((message) => message.role === 'system')
      );
      expect(systemContext).toContain(providerSystem);
      expect(systemContext).toContain('retained working memory');
      expect(committed.every((row) => row.ts !== undefined)).toBe(true);
      const identity = committedRunIdentity(committed, runId);
      expect(identity).toMatchObject({
        assistantMessageId: runId,
        parentMessageId: null,
        userMessageId: command.commandId,
      });
      const transcript = committedMemoryTranscript(committed, resourceId);
      expect(
        transcript.filter((message) => beforeTranscript.some((prior) => prior.id === message.id))
      ).toEqual(beforeTranscript);
      const segments = committed.filter(
        (row) =>
          (row.event.type === 'model.step' || row.event.type === 'model.messages') &&
          row.event.messages.length > 0
      );
      expect(transcript.map((message) => message.id)).toEqual([
        command.commandId,
        ...segments.map(committedRowAddress),
      ]);
      expect(
        transcript[1]?.content.parts.filter((part) => part.type === 'tool-invocation')
      ).toHaveLength(1);
      const native = new MessageList({
        generateMessageId: () => {
          throw new Error('Native created an uncommitted tail identity');
        },
        resourceId,
        threadId,
      });
      native.add(structuredClone(beforeTranscript), 'memory');
      // Native OM's recorded sealed-message shape; the actual public MessageList
      // must accept the unchanged segment without generating its own tail ID.
      for (const message of native.get.all.db()) {
        message.content.metadata = { ...message.content.metadata, mastra: { sealed: true } };
      }
      native.add(structuredClone(transcript), 'response', { merge: false });
      expect(native.get.all.db().map((message) => message.id)).toEqual(
        transcript.map((message) => message.id)
      );
      const nativeSnapshot = await store.memory({ operation: 'read', resourceId });
      expect(nativeSnapshot.entities.some((entity) => entity.threadId === threadId)).toBe(true);
      if (mode === 'OM') {
        expect(observer.doStreamCalls.length).toBeGreaterThan(0);
        expect(receipts).toHaveLength(observer.doStreamCalls.length);
        const usageRows = committed.filter((row) => row.event.type === 'memory.usage');
        expect(usageRows).toHaveLength(receipts.length);
        expect(usageRows.every((row) => row.seq < (committed.at(-1)?.seq ?? 0))).toBe(true);
        expect(usageRows[0]?.event).toMatchObject({
          kind: 'observation',
          // Priced under the observer's catalog id, not the SDK model id.
          modelId: 'openai::gpt-4.1-mini',
          runId,
          usage: { inputTokens: 42, outputTokens: 9, totalTokens: 51 },
        });
        expect(
          nativeSnapshot.entities.some(
            (entity) =>
              entity.kind === 'observation' &&
              typeof entity.payload['activeObservations'] === 'string'
          )
        ).toBe(true);
      }
      await core.close();
      await store.close();
      store = await StateStore.open(root, writerOptions);
      core = await HostCore.open(store, platform, () => () => undefined);
      const replay = await core.read(threadId, 0);
      expect(replay).toEqual(committed);
      expect(committedMemoryTranscript(replay, resourceId)).toEqual(transcript);
      expect(await store.memory({ operation: 'read', resourceId })).toEqual(nativeSnapshot);
      await expect(core.startRun({ ...command, commandId: runId })).rejects.toThrow(/collides/);
      expect(await core.startRun(command)).toEqual({ runId });
      expect(await store.check()).toEqual({ gaps: 0, integrity: 'ok' });
      const all = await Promise.all((await store.readAll()).map((row) => readHostRow(store, row)));
      expect(all).toEqual(replay);
      const secondPause = nextCommitted(
        core,
        ({ event, threadId: rowThread }) =>
          rowThread === threadId &&
          (event.type === 'interaction.requested' || event.type === 'run.finished')
      );
      const second = await core.startRun({
        commandId: randomUUID(),
        modelId: 'scripted',
        prompt: 'Decline the second recorded write.',
        threadId,
      });
      const result = (await secondPause).event;
      if (result.type === 'run.finished') {
        throw new Error(JSON.stringify({ hostPreparedMessages, result }, null, 2));
      }
      expect(result).toMatchObject({ runId: second.runId, type: 'interaction.requested' });
      const secondRows = await core.read(threadId, 0);
      const secondPending = secondRows.find(
        ({ event }) => event.type === 'interaction.requested' && event.runId === second.runId
      )?.event;
      if (secondPending?.type !== 'interaction.requested') {
        throw new Error('The second recorded write has no committed approval');
      }
      const secondPrompt = model.doStreamCalls.at(-1)?.prompt;
      expect(secondPrompt?.filter((message) => message.role !== 'system')[0]?.role).toBe('user');
      if (mode === 'history') {
        expect(JSON.stringify(secondPrompt).includes(command.prompt)).toBe(lastMessages === 40);
      }
      const secondFinished = nextCommitted(
        core,
        ({ event }) => event.type === 'run.finished' && event.runId === second.runId
      );
      await core.respond({
        commandId: randomUUID(),
        decision: 'deny',
        interactionId: secondPending.interactionId,
        runId: second.runId,
        threadId,
      });
      expect((await secondFinished).event).toMatchObject({ outcome: 'completed' });
      expect(executions).toBe(1);
      expect((await core.read(threadId, 0)).slice(0, replay.length)).toEqual(replay);
    } catch (cause) {
      // Preserve the first assertion and inspect committed truth before cleanup
      // aborts an opening owner.
      const [snapshot] = await Promise.allSettled([store.readAll()]);
      failure = new AggregateError(
        [
          cause,
          new Error(
            JSON.stringify({
              admissions: admissions.map(({ readyAt, runId, startedAt }) => ({
                elapsedMs: (readyAt ?? performance.now()) - startedAt,
                ready: readyAt !== undefined,
                runId,
              })),
              lastMessages,
              mode,
              root,
              rows:
                snapshot?.status === 'fulfilled'
                  ? snapshot.value.map((row) => ({
                      runId: row.event['runId'],
                      seq: row.seq,
                      ts: row.ts,
                      type: row.event.type,
                    }))
                  : undefined,
            })
          ),
        ],
        'Memory qualification first failure and owner receipt'
      );
    }
    const cleanup = await Promise.allSettled([core.close()]);
    const writer = await Promise.allSettled([store.close()]);
    const errors = [...cleanup, ...writer].flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    );
    if (errors.length === 0) {
      await rm(root, { force: true, recursive: true });
    }
    if (failure !== undefined || errors.length > 0) {
      const flatten = (cause: unknown): unknown[] =>
        cause instanceof AggregateError ? cause.errors.flatMap(flatten) : [cause];
      throw new AggregateError(
        [...(failure === undefined ? [] : flatten(failure)), ...errors.flatMap(flatten)],
        'Memory-composed host qualification failed'
      );
    }
  }
);
