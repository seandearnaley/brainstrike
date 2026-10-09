import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isProxy } from 'node:util/types';
import { Worker } from 'node:worker_threads';
import { resolveScaledToolResultBudget } from '@brainstrike/agent/tool-runtime';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { createStateStoreIndexer, openIndexer } from '@brainstrike/indexer';
import { processStartTime, RootLock, type StateStore } from '@brainstrike/state-store';
import type { MastraEmbeddingModel } from '@mastra/core/vector';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { expect, onTestFinished } from 'vitest';
import type { StateStoreHostMemoryOptions } from '../../src/adapters/state-store-host-memory.js';
import { attachAgentHost, type HostClient } from '../../src/client.js';
import type { HostLogRow } from '../../src/protocol.js';
import type { AgentHost } from '../../src/runtime.js';
import { deterministicEmbedding } from './memory-vector-host.js';
import { observeFixtureChild, recordFixtureEvent } from './owned-fixture-process.js';
import { RECORDED_VECTOR_PROFILE } from './recorded-memory-vector-port.js';

export const WORKING_FACT = '# Project facts\n- Working memory contribution: coding in Paris.';
/** The observer's catalog id: the id its memory.usage is committed under. */
export const ACCOUNTING_OBSERVER_CATALOG_ID = 'openai::recorded-observer-prompt';
export const OBSERVATION_FACT = 'Observation contribution: preserve the Paris coding decision.';
export const HISTORY_FACT = 'Paris committed source selected by real semantic recall.';

interface DiagnosticEvent {
  readonly at: string;
  readonly detail?: unknown;
  readonly error?: unknown;
  readonly owner: string;
  readonly phase: string;
}

/** Shared fixture-only shape: original identities, recursive causes and real joins. */
export class AccountingFixtureDiagnostics {
  readonly events: DiagnosticEvent[] = [];
  readonly originalFailures: { owner: string; phase: string; cause: unknown }[] = [];
  readonly nodes: Record<string, unknown>[] = [];
  private readonly ids = new WeakMap<object, number>();
  readonly identities: ((cause: unknown) => unknown)[] = [];

  record(owner: string, phase: string, detail?: unknown): void {
    this.events.push({ at: new Date().toISOString(), detail, owner, phase });
  }

  capture(owner: string, phase: string, cause: unknown): void {
    this.originalFailures.push({ cause, owner, phase });
    this.events.push({ at: new Date().toISOString(), error: this.error(cause), owner, phase });
  }

  async join<Value>(owner: string, operation: () => Promise<Value>): Promise<Value> {
    this.record(owner, 'started');
    try {
      const value = await operation();
      this.record(owner, 'fulfilled');
      return value;
    } catch (cause) {
      this.capture(owner, 'rejected', cause);
      throw cause;
    }
  }

  snapshot(): { events: readonly DiagnosticEvent[]; nodes: readonly Record<string, unknown>[] } {
    return { events: this.events, nodes: this.nodes };
  }

  private error(cause: unknown): unknown {
    if (!(typeof cause === 'object' && cause !== null)) {
      return { primitive: typeof cause === 'string' ? cause : String(cause) };
    }
    const prior = this.ids.get(cause);
    if (prior !== undefined) {
      return { ref: prior };
    }
    const id = this.nodes.length + 1;
    this.ids.set(cause, id);
    const node: Record<string, unknown> = { id };
    this.nodes.push(node);
    if (isProxy(cause)) {
      node['proxy'] = true;
      return { ref: id };
    }
    for (const key of ['name', 'message', 'stack', 'code']) {
      let object: object | null = cause;
      while (object) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (descriptor) {
          const value: unknown =
            'value' in descriptor ? descriptor.value : '[accessor not invoked]';
          node[key] =
            typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
              ? value
              : `[${typeof value}]`;
          break;
        }
        object = Object.getPrototypeOf(object);
        if (object && isProxy(object)) {
          break;
        }
      }
    }
    const nested = Object.getOwnPropertyDescriptor(cause, 'cause');
    if (nested) {
      node['cause'] = 'value' in nested ? this.error(nested.value) : '[accessor not invoked]';
    }
    const members = Object.getOwnPropertyDescriptor(cause, 'errors');
    if (members) {
      node['errors'] =
        'value' in members && Array.isArray(members.value) && !isProxy(members.value)
          ? members.value.map((member: unknown) => this.error(member))
          : '[non-data aggregate members]';
    }
    node['identities'] = this.identities.map((identify) => identify(cause));
    return { ref: id };
  }
}

/** Preserve the original primary, with every cleanup rejection in a separate ledger. */
export async function preserveAccountingFixturePrimary<Value>(
  operation: () => Promise<Value>,
  cleanup: () => Promise<void>,
  diagnostics: AccountingFixtureDiagnostics
): Promise<Value> {
  let primary: { cause: unknown } | undefined;
  let completed: { value: Value } | undefined;
  try {
    completed = { value: await operation() };
  } catch (cause) {
    primary = { cause };
    diagnostics.capture('test', 'primary', cause);
  }
  try {
    await cleanup();
  } catch (cause) {
    diagnostics.capture('test', 'cleanup', cause);
    if (!primary) {
      throw cause;
    }
  }
  if (primary) {
    throw primary.cause;
  }
  if (!completed) {
    throw new Error('Fixture operation has no completion or primary failure');
  }
  return completed.value;
}

interface DiagnosticOptions {
  readonly interruptBeforeCommit?: boolean;
  readonly retainRoot?: boolean;
}

function recordedTextModel(
  modelId: string,
  text: string,
  inputTokens: number,
  outputTokens: number
) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunkDelayInMs: null,
        chunks: [
          { type: 'stream-start', warnings: [] },
          { id: 'recorded-text', type: 'text-start' },
          { delta: text, id: 'recorded-text', type: 'text-delta' },
          { id: 'recorded-text', type: 'text-end' },
          {
            finishReason: { raw: 'stop', unified: 'stop' },
            type: 'finish',
            usage: {
              inputTokens: {
                cacheRead: 0,
                cacheWrite: 0,
                noCache: inputTokens,
                total: inputTokens,
              },
              outputTokens: { reasoning: 0, text: outputTokens, total: outputTokens },
            },
          },
        ],
        initialDelayInMs: null,
      }),
    }),
    modelId,
    provider: 'openai.responses',
  });
}

/** Actual emitted production admission, Core, SDK, public Memory and SQLite.
 * Only provider responses and their documented reported usage are scripted.
 */
export async function finalPromptAccountingHost(
  mode: 'observations' | 'recall',
  diagnosticOptions: DiagnosticOptions = {}
) {
  const require = createRequire(import.meta.url);
  const runtime: typeof import('../../src/index.js') = await import(
    pathToFileURL(require.resolve('@brainstrike/agent-host')).href
  );
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bs-final-prompt-accounting-')));
  const resourceId = randomUUID();
  const diagnostics = new AccountingFixtureDiagnostics();
  const checkpointEntered = Promise.withResolvers<void>();
  const checkpointRelease = Promise.withResolvers<void>();
  const checkpoint = diagnosticOptions.interruptBeforeCommit === true;
  const ownedChildren: {
    child: ChildProcess;
    done: Promise<unknown>;
    joined: boolean;
  }[] = [];
  const childChannel = channel('child_process');
  const observeProcess = (message: unknown): void => {
    const child =
      typeof message === 'object' && message !== null && 'process' in message
        ? message.process
        : undefined;
    if (!(child instanceof ChildProcess)) {
      return;
    }
    child.once('spawn', () => {
      if (
        !child.spawnargs.some((arg) =>
          arg.replaceAll('\\', '/').endsWith('/indexer/dist/process-entry.js')
        )
      ) {
        return;
      }
      const pid = child.pid;
      diagnostics.record('indexer.process', 'spawn', {
        executable: child.spawnfile,
        pid,
        start: pid ? processStartTime(pid) : null,
      });
      child.once('exit', (code, signal) =>
        diagnostics.record('indexer.process', 'exit', { code, pid, signal })
      );
      child.once('disconnect', () =>
        diagnostics.record('indexer.process', 'ipc-disconnect', { pid })
      );
      child.once('close', (code, signal) =>
        diagnostics.record('indexer.process', 'close', { code, pid, signal })
      );
      const observed = observeFixtureChild(child, (ownedPid) => ({
        executable: child.spawnfile,
        pid: ownedPid,
        start: processStartTime(ownedPid) ?? 'unavailable',
      }));
      const owned = { child, done: observed.done, joined: false };
      ownedChildren.push(owned);
      observed.done.then(
        (exit) => {
          owned.joined = true;
          diagnostics.record('indexer.process', 'transport-joined', {
            ...exit,
            ipcDisconnected: !(child.connected || child.channel),
            pid,
          });
        },
        (cause: unknown) => diagnostics.capture('indexer.process', 'join-rejected', cause)
      );
    });
  };
  if (checkpoint) {
    childChannel.subscribe(observeProcess);
  }
  const model = recordedTextModel('gpt-6-sol', 'Paris production fixture reply.', 73, 11);
  const observer = recordedTextModel(
    'recorded-observer-prompt',
    `<observations>\n- ${OBSERVATION_FACT}\n</observations>`,
    42,
    9
  );
  const receipts: {
    runId: string;
    request: Parameters<StateStoreHostMemoryOptions['recordPrompt']>[1];
  }[] = [];
  const queries: unknown[] = [];
  const recordedEmbeddings: string[][] = [];
  const embedder: Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }> = {
    doEmbed: async ({ values, abortSignal }) => {
      abortSignal?.throwIfAborted();
      recordedEmbeddings.push([...values]);
      return {
        embeddings: values.map(deterministicEmbedding),
        usage: { tokens: values.length },
        warnings: [],
      };
    },
    maxEmbeddingsPerCall: 1,
    modelId: RECORDED_VECTOR_PROFILE.modelId,
    provider: 'local-fixture',
    specificationVersion: 'v3',
    supportsParallelCalls: false,
  };
  let store: StateStore | undefined;
  let ownedWriter: { worker: Worker; threadId: number; exited: number | null } | undefined;
  let indexer: Awaited<ReturnType<typeof openIndexer>> | undefined;
  let host: AgentHost | undefined;
  let client: HostClient | undefined;
  let observations = false;
  let inputTokenLimit = 20_000;
  let closing: Promise<void> | undefined;
  const failed = Promise.withResolvers<never>();
  failed.promise.catch(() => undefined);
  const observe = <Value>(work: Promise<Value>, owner = 'run.memory'): Promise<Value> =>
    work.catch((cause: unknown) => {
      diagnostics.capture(owner, 'rejected', cause);
      failed.reject(cause);
      throw cause;
    });
  const waits = new Set<(cause: unknown) => void>();
  const close = () =>
    (closing ??= (async () => {
      try {
        await diagnostics.join('host.close', async () => host?.close());
      } finally {
        await diagnostics.join('client.close', async () => client?.close());
        childChannel.unsubscribe(observeProcess);
        diagnostics.record('root', 'close-state', {
          processes: ownedChildren.map(({ child, joined }) => ({
            exitCode: child.exitCode,
            ipcDisconnected: !(child.connected || child.channel),
            joined,
            pid: child.pid,
            signalCode: child.signalCode,
          })),
          released: RootLock.inspect(root)?.owner.released === true,
          writer: ownedWriter
            ? {
                currentThreadId: ownedWriter.worker.threadId,
                exitCode: ownedWriter.exited,
                threadId: ownedWriter.threadId,
              }
            : null,
        });
      }
      expect(RootLock.inspect(root)?.owner.released).toBe(true);
      if (!diagnosticOptions.retainRoot) {
        await rm(root, { force: true, recursive: true });
      }
    })());
  onTestFinished(async ({ signal }) => {
    if (signal.aborted) {
      for (const reject of waits) {
        reject(signal.reason);
      }
    }
    if (diagnostics.events.some((event) => event.phase === 'primary')) {
      try {
        await close();
      } catch (cause) {
        diagnostics.capture('test-hook', 'cleanup', cause);
      }
    } else {
      await close();
    }
    if (checkpoint || diagnostics.originalFailures.length > 0) {
      console.error(
        'Accounting fixture diagnostic receipt:',
        JSON.stringify({ root, ...diagnostics.snapshot() })
      );
      recordFixtureEvent('accounting-diagnostic-receipt', { root, ...diagnostics.snapshot() });
    }
  });
  try {
    host = await runtime.startAgentHost({ lifetime: 'persistent', root }, async (startup) => {
      store = startup.store;
      if (checkpoint) {
        const writer = Object.getOwnPropertyDescriptor(store, 'worker')?.value;
        if (!(writer instanceof Worker)) {
          throw new Error('The actual StateStore writer-thread owner is unavailable');
        }
        const threadId = writer.threadId;
        ownedWriter = { exited: null, threadId, worker: writer };
        diagnostics.record('state-store.writer', 'acquired', { pid: process.pid, threadId });
        writer.once('exit', (code) => {
          if (ownedWriter) {
            ownedWriter.exited = code;
          }
          diagnostics.record('state-store.writer', 'exit', { code, threadId });
        });
        const storeClose = store.close.bind(store);
        store.close = () => diagnostics.join('state-store.close', storeClose);
      }
      if (mode === 'recall') {
        await startup.register(async () => {
          try {
            await diagnostics.join('indexer.close', async () => indexer?.close());
          } finally {
            await Promise.allSettled(
              ownedChildren
                .filter(({ child }) => child.exitCode !== null || child.signalCode !== null)
                .map(({ done }) => done)
            );
          }
        });
        indexer = await openIndexer(
          {
            dbPath: join(root, 'index.sqlite'),
            embedding: { indexMode: 'text-only' },
            rootIds: [root],
            stateProjection: {
              mode: 'dev',
              module: pathToFileURL(require.resolve('@brainstrike/agent-host/state-projection'))
                .href,
            },
            stateResources: [{ resourceId, rootId: root }],
            stateRoot: root,
          },
          { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 }
        );
      }
      const platform = await runtime.createProductionHostPlatform({
        close: async () => diagnostics.record('production.options.close', 'fulfilled'),
        readConfiguration: async (request) => {
          const writer = indexer;
          const bridge = writer
            ? runtime.StateStoreHostMemory.createVectorBridge({
                port: {
                  prepareStateMessageVectors: (input) => writer.prepareStateMessageVectors(input),
                  purgeStateMessageVectors: (input) => writer.purgeStateMessageVectors(input),
                  queryStateMessageVectors: (input) => {
                    queries.push(structuredClone(input));
                    return writer.queryStateMessageVectors(input);
                  },
                  upsertStateMessageVectors: (input) => writer.upsertStateMessageVectors(input),
                },
                profile: RECORDED_VECTOR_PROFILE,
                scope: { resourceId, rootId: root, threadId: request.threadId },
                signal: request.signal,
              })
            : undefined;
          return {
            configuration: { model: model.modelId, provider: 'openai' },
            durableConfiguration: { inputTokenLimit, mode, observations },
            maxSteps: 1,
            memory: {
              native: {
                ...(bridge ? { embedder, vector: bridge } : {}),
                options: {
                  lastMessages: mode === 'recall' ? 1 : 40,
                  observationalMemory: observations
                    ? {
                        model: observer,
                        observation: {
                          bufferOnIdle: false,
                          bufferTokens: false,
                          messageTokens: 100,
                        },
                        reflection: { observationTokens: 50_000 },
                        scope: 'thread',
                      }
                    : false,
                  semanticRecall: bridge ? { messageRange: 0, scope: 'resource', topK: 1 } : false,
                  workingMemory: { enabled: true, scope: 'thread' },
                },
              },
              ...(observations ? { observerModelId: ACCOUNTING_OBSERVER_CATALOG_ID } : {}),
              recordPrompt: async (identity, requestParams) => {
                receipts.push({ request: requestParams, runId: identity.runId });
              },
              resourceId,
              ...(bridge ? { vectorBridge: bridge } : {}),
            },
            providerRequestContext: {
              inputTokenLimit,
              provider: 'openai',
              runtimeData: { model: model.modelId },
            },
            resolvedToolResultBudget: resolveScaledToolResultBudget(20_000),
            system: 'Fixture coding instructions: preserve selected context and project facts.',
            tools: {},
            toolTimeoutMs: 1000,
          };
        },
        readPermissionPolicy: () => ({ policies: DEFAULT_PERMISSION_POLICIES, yolo: false }),
        resolveModel: async () => model,
        resolveProviderAuth: async () => undefined,
        startup,
        ...(indexer ? { stateIndexer: createStateStoreIndexer(indexer) } : {}),
      });
      const admit = platform.admitRun;
      const platformClose = platform.close.bind(platform);
      platform.close = () => diagnostics.join('platform.close', platformClose);
      if (!admit) {
        throw new Error('Production admission is unavailable');
      }
      platform.admitRun = async (request) => {
        const selected = await observe(admit(request), 'run.admission');
        const open = selected.openRun;
        if (!open) {
          throw new Error('Production Memory owner is unavailable');
        }
        return {
          ...selected,
          openRun: async (context) => {
            const owner = await observe(open(context));
            if (!(owner instanceof runtime.StateStoreHostMemory)) {
              throw new Error('Production admission did not acquire public StateStore Memory');
            }
            if (checkpoint) {
              const providers: unknown = Object.getOwnPropertyDescriptor(
                owner.memory,
                'providers'
              )?.value;
              if (
                !(
                  providers &&
                  typeof providers === 'object' &&
                  'ownsCancellation' in providers &&
                  typeof providers.ownsCancellation === 'function'
                )
              ) {
                throw new Error('The actual Memory cancellation owner is unavailable');
              }
              const owns = providers.ownsCancellation.bind(providers);
              diagnostics.identities.push((cause) => ({
                equalsRunAbort: context.signal.aborted && cause === context.signal.reason,
                ownedMemoryCancellation: owns(cause),
                runId: context.runId,
              }));
              context.signal.addEventListener(
                'abort',
                () => {
                  diagnostics.capture('run.signal', 'abort', context.signal.reason);
                  checkpointRelease.resolve();
                },
                { once: true }
              );
              const memoryClose = owner.memory.close.bind(owner.memory);
              owner.memory.close = () => diagnostics.join('public-memory.close', memoryClose);
            }
            await observe(owner.memory.updateWorkingMemory(WORKING_FACT));
            return {
              close: () => observe(diagnostics.join('run.owner.close', () => owner.close())),
              commitHostStep: () =>
                observe(
                  diagnostics.join('run.checkpoint', async () => {
                    if (checkpoint) {
                      checkpointEntered.resolve();
                      await checkpointRelease.promise;
                    }
                    await owner.commitHostStep();
                  }),
                  'run.checkpoint'
                ),
              prepareHostModel: (selectedModel) => owner.prepareHostModel(selectedModel),
              prepareHostStep: (step) => observe(owner.prepareHostStep(step)),
            };
          },
        };
      };
      return platform;
    });
    client = await attachAgentHost(host.record);
    const connected = client;
    const opened = host;
    return {
      checkpointEntered: checkpointEntered.promise,
      close,
      diagnostics,
      embeddingCalls: recordedEmbeddings,
      enableObservations: () => {
        observations = true;
      },
      model,
      observer,
      queries,
      receipts,
      resourceId,
      root,
      run: async (
        threadId: string,
        prompt: string
      ): Promise<{ runId: string; rows: HostLogRow[] }> => {
        const finished =
          Promise.withResolvers<Extract<HostLogRow['event'], { type: 'run.finished' }>>();
        waits.add(finished.reject);
        const unsubscribe = opened.core.onCommitted((row) => {
          if (row.threadId === threadId && row.event.type === 'run.finished') {
            finished.resolve(row.event);
          }
        });
        try {
          const { runId } = await connected.request('run/start', {
            commandId: randomUUID(),
            modelId: 'openai::gpt-6-sol',
            prompt,
            threadId,
          });
          const terminal = await Promise.race([finished.promise, failed.promise]);
          expect(terminal).toMatchObject({ outcome: 'completed', runId });
          const { rows } = await connected.request('thread/read', { fromSeq: 0, threadId });
          return { rows, runId };
        } finally {
          unsubscribe();
          waits.delete(finished.reject);
        }
      },
      runWithOriginalPolling: async (threadId: string, prompt: string) => {
        const { runId } = await connected.request('run/start', {
          commandId: randomUUID(),
          modelId: 'openai::gpt-6-sol',
          prompt,
          threadId,
        });
        let rows: HostLogRow[] = [];
        if (checkpoint) {
          // Establish the captured post-step interruption boundary before using
          // the original poll. Cold admission can otherwise expire that poll
          // before Memory has acquired an owner, which is a distinct trigger.
          await Promise.race([checkpointEntered.promise, failed.promise]);
        }
        // Exact original wait/trigger reconstructed from the preserved first-red
        // source excerpt; retain Vitest's existing default poll deadline.
        await expect
          .poll(async () => {
            rows = (await connected.request('thread/read', { fromSeq: 0, threadId })).rows;
            return rows.findLast((row) => row.event.type === 'run.finished')?.event;
          })
          .toMatchObject({ outcome: 'completed' });
        return { rows, runId };
      },
      setInputTokenLimit(value: number) {
        inputTokenLimit = value;
      },
      startThread: () => connected.request('thread/start', { commandId: randomUUID() }),
      store: () => {
        if (!store) {
          throw new Error('The actual Root writer is unavailable');
        }
        return store;
      },
      within: <Value>(operation: () => Promise<Value>): Promise<Value> =>
        preserveAccountingFixturePrimary(operation, close, diagnostics),
    };
  } catch (cause) {
    diagnostics.capture('setup', 'primary', cause);
    try {
      await close();
    } catch (cleanup) {
      diagnostics.capture('setup', 'cleanup', cleanup);
    }
    throw cause;
  }
}
