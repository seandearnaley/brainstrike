import {
  createProviderRequestMiddleware,
  healInterruptedModelMessages,
  type ProviderRequestContext,
} from '@brainstrike/agent/provider-request';
import type { StateStore } from '@brainstrike/state-store';
import type { MastraDBMessage } from '@mastra/core/agent';
import { MessageList } from '@mastra/core/agent';
import { MastraCompositeStore } from '@mastra/core/storage';
import {
  type LanguageModel,
  type LanguageModelMiddleware,
  type ModelMessage,
  modelMessageSchema,
  wrapLanguageModel,
} from 'ai';
import { committedRowAddress, committedRunIdentity } from '../committed-identities.js';
import { readHostRow } from '../event-storage.js';
import type { HostRunContext, HostRunOwner } from '../ports.js';
import type { HostLogRow } from '../protocol.js';
import { committedMemoryTranscript } from './committed-memory-transcript.js';
import { HostMemory, type HostMemoryCapabilities, type HostMemoryIdentity } from './memory.js';
import { StateStoreMemoryStorage } from './memory-storage.js';

export interface StateStoreHostMemoryOptions {
  readonly native: Omit<HostMemoryCapabilities['native'], 'storage'>;
  readonly providerRequestContext?: () => ProviderRequestContext | Promise<ProviderRequestContext>;
  readonly recordObserverUsage?: HostMemoryCapabilities['recordObserverUsage'];
  readonly recordPrompt: HostMemoryCapabilities['recordPrompt'];
  readonly resourceId: string;
  readonly store: StateStore;
}

/** The existing run owner encloses public Memory and its borrowed writer domain. */
export class StateStoreHostMemory implements HostRunOwner {
  private closing: Promise<void> | undefined;

  private constructor(
    readonly memory: HostMemory,
    private readonly identity: HostMemoryIdentity,
    private readonly domain: StateStoreMemoryStorage,
    private readonly storage: MastraCompositeStore,
    private readonly readRows: () => Promise<HostLogRow[]>,
    private readonly providerContext: ProviderRequestContext | undefined
  ) {}

  static async open(
    context: HostRunContext,
    options: StateStoreHostMemoryOptions
  ): Promise<StateStoreHostMemory> {
    // Snapshot configuration before constructing native run-owned resources.
    const providerContext = await options.providerRequestContext?.();
    const readRows = async (): Promise<HostLogRow[]> =>
      Promise.all((await options.store.readAll()).map((row) => readHostRow(options.store, row)));
    const readTranscript = async (): Promise<MastraDBMessage[]> =>
      committedMemoryTranscript(await readRows(), options.resourceId);
    const identity = { ...context, resourceId: options.resourceId };
    const domain = new StateStoreMemoryStorage(
      options.resourceId,
      options.store,
      {
        read: readTranscript,
      },
      context.threadId
    );
    const storage = new MastraCompositeStore({
      domains: { memory: domain },
      id: options.resourceId,
    });
    const memory = new HostMemory(identity, {
      native: { ...options.native, storage },
      recordObserverUsage: async (current, receipt) => {
        if (!context.recordObserverUsage) {
          throw new Error('Public Memory requires the host-owned usage receipt writer');
        }
        await context.recordObserverUsage(receipt);
        await options.recordObserverUsage?.(current, receipt);
      },
      recordPrompt: options.recordPrompt,
    });
    const owner = new StateStoreHostMemory(
      memory,
      identity,
      domain,
      storage,
      readRows,
      providerContext
    );
    try {
      await storage.init();
      const rows = await readRows();
      const committed = committedRunIdentity(rows, context.runId);
      if (!(await domain.getThreadById({ threadId: context.threadId }))) {
        await domain.saveThread({
          thread: {
            createdAt: committed.createdAt,
            id: context.threadId,
            metadata: {},
            resourceId: options.resourceId,
            updatedAt: committed.createdAt,
          },
        });
      }
      const currentIds = new Set(
        rows.flatMap((row) =>
          'runId' in row.event && row.event.runId === context.runId
            ? [committedRowAddress(row)]
            : []
        )
      );
      currentIds.add(committed.userMessageId);
      const current = (await readTranscript()).filter((message) => currentIds.has(message.id));
      await memory.beginTurn(current);
      return owner;
    } catch (cause) {
      try {
        await owner.close();
      } catch (cleanup) {
        throw new AggregateError([cause, cleanup], 'Memory construction cleanup failed');
      }
      throw cause;
    }
  }

  prepareHostModel(model: LanguageModel): LanguageModel {
    const selected = this.providerContext;
    if (!selected) {
      return model;
    }
    if (typeof model === 'string') {
      throw new Error('Host provider preparation requires the selected concrete model');
    }
    const middleware = createProviderRequestMiddleware({
      context: async () => ({
        ...selected,
        history: committedMemoryTranscript(await this.readRows(), this.identity.resourceId),
      }),
      onPrepared: async (prepared) => {
        if (!this.identity.recordProviderRequest) {
          throw new Error('Provider preparation requires the host-owned receipt writer');
        }
        await this.identity.recordProviderRequest({
          accounting: prepared.accounting,
          modelId: model.modelId,
          provider: selected.provider,
        });
        await this.memory.recordPrompt(prepared.params);
      },
    });
    return wrapLanguageModel({
      // Both pins implement the public V4 primitive. The older provider's
      // declaration omits readonly JSON, while the installed SDK permits it.
      // Keep this DTO type bridge here; adding ai 7 to the legacy agent package
      // would change its separate Mastra/ai 6 peer closure. Joined tests compare
      // the prepared public params to the actual SDK model call without copies.
      // https://github.com/vercel/ai/tree/main/packages/provider
      // Remove this type bridge when both existing declaration pins agree.
      middleware: middleware as unknown as LanguageModelMiddleware,
      model,
    });
  }

  async prepareHostStep(request: {
    readonly messages: readonly ModelMessage[];
    readonly stepNumber: number;
  }): Promise<{ messages: ModelMessage[]; system?: string }> {
    const step = await this.memory.prepareStep(request.stepNumber);
    const selected = new Set(step.messages.map((message) => message.id));
    const rows = await this.readRows();
    const historical: ModelMessage[] = [];
    for (const started of rows) {
      if (
        started.threadId !== this.identity.threadId ||
        started.event.type !== 'run.started' ||
        started.event.runId === this.identity.runId
      ) {
        continue;
      }
      const previousRunId = started.event.runId;
      const previous = committedRunIdentity(rows, previousRunId);
      if (selected.has(previous.userMessageId)) {
        historical.push({ content: started.event.prompt, role: 'user' });
      }
      if (
        !rows.some(
          (row) =>
            'runId' in row.event &&
            row.event.runId === previousRunId &&
            selected.has(committedRowAddress(row))
        )
      ) {
        continue;
      }
      const occurrence = rows.flatMap((row) => {
        const event = row.event;
        return row.threadId === this.identity.threadId &&
          (event.type === 'model.step' || event.type === 'model.messages') &&
          event.runId === previousRunId
          ? event.messages.map((message) => modelMessageSchema.parse(message))
          : [];
      });
      const interrupted = rows.some((row) => {
        const event = row.event;
        return (
          event.type === 'run.finished' &&
          event.runId === previousRunId &&
          (event.outcome === 'interrupted' || event.outcome === 'stopped')
        );
      });
      if (interrupted) {
        const calls = new Set(
          occurrence.flatMap((message) =>
            message.role === 'assistant' && typeof message.content !== 'string'
              ? message.content.flatMap((part) =>
                  part.type === 'tool-call' ? [part.toolCallId] : []
                )
              : []
          )
        );
        historical.push(...healInterruptedModelMessages(occurrence, calls));
      } else {
        historical.push(...occurrence);
      }
    }
    // Active SDK messages retain their actual validated approval/runtime objects.
    // Public Memory selects previous committed turns, never reconstructs an
    // active call or changes the existing host approval occurrence.
    const currentUser = request.messages.findLastIndex((message) => message.role === 'user');
    if (currentUser < 0) {
      throw new Error('Memory preparation has no current committed user input');
    }
    const system = [step.context.systemMessage, step.context.otherThreadsContext]
      .filter((part) => part !== undefined && part.length > 0)
      .join('\n\n');
    const continuation = new MessageList({
      resourceId: this.identity.resourceId,
      threadId: this.identity.threadId,
    });
    if (step.context.continuationMessage) {
      continuation.add([step.context.continuationMessage], 'memory');
    }
    return {
      messages: [
        ...historical,
        ...continuation.get.all.aiV5.model().map((message) => modelMessageSchema.parse(message)),
        ...request.messages.slice(currentUser),
      ],
      ...(system ? { system } : {}),
    };
  }

  async commitHostStep(): Promise<void> {
    const rows = await this.readRows();
    const committed = committedRunIdentity(rows, this.identity.runId);
    const currentIds = new Set(
      rows.flatMap((row) =>
        'runId' in row.event && row.event.runId === this.identity.runId
          ? [committedRowAddress(row)]
          : []
      )
    );
    currentIds.add(committed.userMessageId);
    const current = committedMemoryTranscript(rows, this.identity.resourceId).filter((message) =>
      currentIds.has(message.id)
    );
    await this.memory.commitStep(current);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.memory.close();
      await this.domain.close();
      await this.storage.close();
    })();
    return this.closing;
  }
}
