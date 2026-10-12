import type {
  MemoryDomainPort,
  MemoryJsonObject,
  MemoryNativeMethod,
} from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { InMemoryStore, MemoryStorage } from '@mastra/core/storage';
import { decodeMemory, encodeMemory, memoryConfiguration } from './memory-storage-codec.js';

export interface CommittedMemoryTranscript {
  /**
   * One consistent canonical projection, using committed host identities: the
   * given threads' messages, or every thread of the resource without them.
   */
  read(threadIds?: ReadonlySet<string>): Promise<readonly MastraDBMessage[]>;
}

/**
 * The threads a thread-scoped message query can answer from: its own and any
 * included message's thread. An include without a thread may name a message
 * of any thread, so that query reads the whole resource.
 */
function queriedThreads(
  args: Parameters<MemoryStorage['listMessages']>[0]
): ReadonlySet<string> | undefined {
  const include = args.include ?? [];
  if (include.some((entry) => entry.threadId === undefined)) {
    return;
  }
  return new Set([
    ...(Array.isArray(args.threadId) ? args.threadId : [args.threadId]),
    ...include.flatMap((entry) => (entry.threadId === undefined ? [] : [entry.threadId])),
  ]);
}

/** Native storage surface over the existing SQLite writer and committed transcript. */
export class StateStoreMemoryStorage extends MemoryStorage {
  override readonly supportsObservationalMemory = true;
  override readonly supportsPartialThreadUpdate = true;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failures: unknown[] = [];
  private closing: Promise<void> | undefined;

  constructor(
    readonly resourceId: string,
    private readonly writer: MemoryDomainPort,
    private readonly transcript: CommittedMemoryTranscript,
    private readonly ownerThreadId?: string
  ) {
    super();
  }

  private admit<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.closing) {
      return Promise.reject(new Error('Memory storage admission is closed'));
    }
    const work = Promise.resolve().then(operation);
    this.pending.add(work);
    work.then(
      () => this.pending.delete(work),
      (cause: unknown) => {
        this.pending.delete(work);
        this.failures.push(cause);
      }
    );
    return work;
  }

  private call<Value>(method: MemoryNativeMethod, args: readonly unknown[]): Promise<Value> {
    return this.admit(async () => {
      const input = [...args];
      while (input.length > 0 && input.at(-1) === undefined) {
        input.pop();
      }
      if (
        (method === 'initializeObservationalMemory' ||
          method === 'updateObservationalMemoryConfig') &&
        input[0] &&
        typeof input[0] === 'object' &&
        'config' in input[0] &&
        input[0].config &&
        typeof input[0].config === 'object'
      ) {
        input[0] = {
          ...input[0],
          config: memoryConfiguration(input[0].config as Record<string, unknown>),
        };
      }
      const encoded = encodeMemory(input);
      if (!Array.isArray(encoded)) {
        throw new TypeError('Invalid native storage arguments');
      }
      const result = await this.writer.memory({
        arguments: encoded,
        method,
        operation: 'native',
        resourceId: this.resourceId,
        ...(this.ownerThreadId === undefined ? {} : { ownerThreadId: this.ownerThreadId }),
      });
      return decodeMemory(result.value ?? null) as Value;
    });
  }

  override getThreadById(
    ...args: Parameters<MemoryStorage['getThreadById']>
  ): ReturnType<MemoryStorage['getThreadById']> {
    return this.call('getThreadById', args);
  }

  override saveThread(
    ...args: Parameters<MemoryStorage['saveThread']>
  ): ReturnType<MemoryStorage['saveThread']> {
    return this.call('saveThread', args);
  }

  override updateThread(
    ...args: Parameters<MemoryStorage['updateThread']>
  ): ReturnType<MemoryStorage['updateThread']> {
    return this.call('updateThread', args);
  }

  override listThreads(
    ...args: Parameters<MemoryStorage['listThreads']>
  ): ReturnType<MemoryStorage['listThreads']> {
    return this.call('listThreads', args);
  }

  override getResourceById(
    ...args: Parameters<MemoryStorage['getResourceById']>
  ): ReturnType<MemoryStorage['getResourceById']> {
    return this.call('getResourceById', args);
  }

  override saveResource(
    ...args: Parameters<MemoryStorage['saveResource']>
  ): ReturnType<MemoryStorage['saveResource']> {
    return this.call('saveResource', args);
  }

  override updateResource(
    ...args: Parameters<MemoryStorage['updateResource']>
  ): ReturnType<MemoryStorage['updateResource']> {
    return this.call('updateResource', args);
  }

  override getObservationalMemory(
    ...args: Parameters<MemoryStorage['getObservationalMemory']>
  ): ReturnType<MemoryStorage['getObservationalMemory']> {
    return this.call('getObservationalMemory', args);
  }

  override getObservationalMemoryHistory(
    ...args: Parameters<MemoryStorage['getObservationalMemoryHistory']>
  ): ReturnType<MemoryStorage['getObservationalMemoryHistory']> {
    return this.call('getObservationalMemoryHistory', args);
  }

  override initializeObservationalMemory(
    ...args: Parameters<MemoryStorage['initializeObservationalMemory']>
  ): ReturnType<MemoryStorage['initializeObservationalMemory']> {
    return this.call('initializeObservationalMemory', args);
  }

  override insertObservationalMemoryRecord(
    ...args: Parameters<MemoryStorage['insertObservationalMemoryRecord']>
  ): ReturnType<MemoryStorage['insertObservationalMemoryRecord']> {
    return this.call('insertObservationalMemoryRecord', args);
  }

  override updateActiveObservations(
    ...args: Parameters<MemoryStorage['updateActiveObservations']>
  ): ReturnType<MemoryStorage['updateActiveObservations']> {
    return this.call('updateActiveObservations', args);
  }

  override updateBufferedObservations(
    ...args: Parameters<MemoryStorage['updateBufferedObservations']>
  ): ReturnType<MemoryStorage['updateBufferedObservations']> {
    return this.call('updateBufferedObservations', args);
  }

  override swapBufferedToActive(
    ...args: Parameters<MemoryStorage['swapBufferedToActive']>
  ): ReturnType<MemoryStorage['swapBufferedToActive']> {
    return this.call('swapBufferedToActive', args);
  }

  override createReflectionGeneration(
    ...args: Parameters<MemoryStorage['createReflectionGeneration']>
  ): ReturnType<MemoryStorage['createReflectionGeneration']> {
    return this.call('createReflectionGeneration', args);
  }

  override updateBufferedReflection(
    ...args: Parameters<MemoryStorage['updateBufferedReflection']>
  ): ReturnType<MemoryStorage['updateBufferedReflection']> {
    return this.call('updateBufferedReflection', args);
  }

  override swapBufferedReflectionToActive(
    ...args: Parameters<MemoryStorage['swapBufferedReflectionToActive']>
  ): ReturnType<MemoryStorage['swapBufferedReflectionToActive']> {
    return this.call('swapBufferedReflectionToActive', args);
  }

  override setReflectingFlag(
    ...args: Parameters<MemoryStorage['setReflectingFlag']>
  ): ReturnType<MemoryStorage['setReflectingFlag']> {
    return this.call('setReflectingFlag', args);
  }

  override setObservingFlag(
    ...args: Parameters<MemoryStorage['setObservingFlag']>
  ): ReturnType<MemoryStorage['setObservingFlag']> {
    return this.call('setObservingFlag', args);
  }

  override setBufferingObservationFlag(
    ...args: Parameters<MemoryStorage['setBufferingObservationFlag']>
  ): ReturnType<MemoryStorage['setBufferingObservationFlag']> {
    return this.call('setBufferingObservationFlag', args);
  }

  override setBufferingReflectionFlag(
    ...args: Parameters<MemoryStorage['setBufferingReflectionFlag']>
  ): ReturnType<MemoryStorage['setBufferingReflectionFlag']> {
    return this.call('setBufferingReflectionFlag', args);
  }

  override clearObservationalMemory(
    ...args: Parameters<MemoryStorage['clearObservationalMemory']>
  ): ReturnType<MemoryStorage['clearObservationalMemory']> {
    return this.call('clearObservationalMemory', args);
  }

  override setPendingMessageTokens(
    ...args: Parameters<MemoryStorage['setPendingMessageTokens']>
  ): ReturnType<MemoryStorage['setPendingMessageTokens']> {
    return this.call('setPendingMessageTokens', args);
  }

  override updateObservationalMemoryConfig(
    ...args: Parameters<MemoryStorage['updateObservationalMemoryConfig']>
  ): ReturnType<MemoryStorage['updateObservationalMemoryConfig']> {
    return this.call('updateObservationalMemoryConfig', args);
  }

  override updateThreadMetadata(
    args: Parameters<MemoryStorage['updateThreadMetadata']>[0]
  ): ReturnType<MemoryStorage['updateThreadMetadata']> {
    return this.admit(async () => {
      const snapshot = await this.writer.memory({ operation: 'read', resourceId: this.resourceId });
      const row = snapshot.entities.find(
        (entry) => entry.kind === 'thread' && entry.id === args.id
      );
      if (!row) {
        return null;
      }
      const thread = decodeMemory(row.payload) as NonNullable<
        Awaited<ReturnType<MemoryStorage['getThreadById']>>
      >;
      if (args.resourceId && args.resourceId !== thread.resourceId) {
        return null;
      }
      const metadata = args.update(structuredClone(thread));
      if (metadata === undefined) {
        return thread;
      }
      const updated = {
        ...thread,
        metadata: { ...thread.metadata, ...metadata },
        updatedAt: new Date(),
      };
      const payload = encodeMemory(updated) as MemoryJsonObject;
      await this.writer.memory({
        changes: [{ entity: { ...row, payload }, operation: 'put' }],
        expectedRevision: snapshot.revision,
        operation: 'commit',
        resourceId: this.resourceId,
        ...(this.ownerThreadId === undefined ? {} : { ownerThreadId: this.ownerThreadId }),
      });
      return updated;
    });
  }

  private async withTranscript<Value>(
    threadIds: ReadonlySet<string> | undefined,
    operation: (native: MemoryStorage) => Promise<Value>
  ): Promise<Value> {
    const messages = await this.transcript.read(threadIds);
    if (messages.some((message) => message.resourceId !== this.resourceId)) {
      throw new Error('Canonical transcript crossed its resource owner');
    }
    const projection = new InMemoryStore({ id: this.resourceId });
    await projection.init();
    try {
      const native = await projection.getStore('memory');
      if (!native) {
        throw new Error('Public native projection is absent');
      }
      const snapshot = await this.writer.memory({ operation: 'read', resourceId: this.resourceId });
      for (const row of snapshot.entities) {
        if (row.kind === 'thread') {
          await native.saveThread({
            thread: decodeMemory(row.payload) as Parameters<
              MemoryStorage['saveThread']
            >[0]['thread'],
          });
        } else if (row.kind === 'resource') {
          await native.saveResource({
            resource: decodeMemory(row.payload) as Parameters<
              MemoryStorage['saveResource']
            >[0]['resource'],
          });
        }
      }
      await native.saveMessages({ messages: structuredClone([...messages]) });
      return await operation(native);
    } finally {
      await projection.close();
    }
  }

  override listMessages(
    ...args: Parameters<MemoryStorage['listMessages']>
  ): ReturnType<MemoryStorage['listMessages']> {
    return this.admit(() =>
      this.withTranscript(queriedThreads(args[0]), (native) => native.listMessages(...args))
    );
  }

  override listMessagesByResourceId(
    ...args: Parameters<MemoryStorage['listMessagesByResourceId']>
  ): ReturnType<MemoryStorage['listMessagesByResourceId']> {
    return this.admit(() =>
      this.withTranscript(undefined, (native) => native.listMessagesByResourceId(...args))
    );
  }

  override listMessagesById(
    ...args: Parameters<MemoryStorage['listMessagesById']>
  ): ReturnType<MemoryStorage['listMessagesById']> {
    return this.admit(() =>
      this.withTranscript(undefined, (native) => native.listMessagesById(...args))
    );
  }

  override saveMessages({
    messages,
  }: Parameters<MemoryStorage['saveMessages']>[0]): ReturnType<MemoryStorage['saveMessages']> {
    return this.admit(async () => {
      const threads = new Set(
        messages.flatMap((message) => (message.threadId === undefined ? [] : [message.threadId]))
      );
      const committed = new Map(
        (await this.transcript.read(threads)).map((message) => [message.id, message])
      );
      const selected = messages.map((message) => {
        const row = committed.get(message.id);
        if (!row || row.threadId !== message.threadId || row.resourceId !== this.resourceId) {
          throw new Error('Native transcript projection is not canonically committed');
        }
        return structuredClone(row);
      });
      return { messages: selected };
    });
  }

  override updateMessages(
    _args: Parameters<MemoryStorage['updateMessages']>[0]
  ): ReturnType<MemoryStorage['updateMessages']> {
    return this.admit(async () => {
      throw new Error('Transcript mutation belongs to the canonical host');
    });
  }
  override deleteMessages(_ids: string[]): Promise<void> {
    return this.admit(async () => {
      throw new Error('Transcript deletion belongs to the canonical host');
    });
  }
  override deleteThread(_args: Parameters<MemoryStorage['deleteThread']>[0]): Promise<void> {
    return this.admit(async () => {
      throw new Error('Strict thread purge belongs to the canonical host');
    });
  }
  override dangerouslyClearAll(): Promise<void> {
    return this.admit(async () => {
      throw new Error('Factory reset belongs to the canonical host owner');
    });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      while (this.pending.size > 0) {
        await Promise.allSettled([...this.pending]);
      }
      if (this.failures.length > 0) {
        throw new AggregateError([...new Set(this.failures)], 'Memory storage cleanup failed');
      }
    })();
    return this.closing;
  }
}
