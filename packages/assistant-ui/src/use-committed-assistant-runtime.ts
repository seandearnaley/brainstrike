import {
  type AppendMessage,
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ExternalThreadQueueAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  bindCommittedAssistantCommands,
  type CommittedAssistantCommands,
  type CommittedAssistantSnapshot,
  type CommittedAssistantStore,
  CommittedRunStarts,
} from './committed-assistant-store';
import { threadMessageQueue } from './thread-message-queue';

/** Object.is compares the selected fold object, so unrelated tokens do not rerender a card. */
export function useCommittedAssistantSelector<T>(
  store: CommittedAssistantStore,
  select: (snapshot: CommittedAssistantSnapshot) => T
): T {
  const getSnapshot = useCallback(() => select(store.getSnapshot()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export interface CommittedAssistantRuntimeOptions {
  readonly adapters?: ExternalStoreAdapter<ThreadMessage>['adapters'];
  readonly commands: CommittedAssistantCommands;
  readonly onCommandError: (cause: unknown) => void;
  readonly store: CommittedAssistantStore;
}

type Repository = CommittedAssistantSnapshot['repository'];

/** Every change that must hand the vendor a fresh envelope. */
type EnvelopeInputs = readonly [
  repository: Repository,
  selectedHeadId: string | null | undefined,
  connection: CommittedAssistantSnapshot['connection'],
  error: CommittedAssistantSnapshot['error'],
  resync: number,
];

function repositoryEnvelope(
  repository: Repository,
  selectedHeadId: string | null | undefined
): Repository {
  return selectedHeadId === undefined
    ? { ...repository }
    : { ...repository, headId: selectedHeadId };
}

/**
 * Bind the production surface to already committed, fully shaped vendor messages.
 * Using messageRepository avoids a converter copying tools/approval parts on every
 * token and preserves branches, message ids and per-part references from the fold.
 * No model, transport, replay loop or transcript writer is constructed here.
 */
export function useCommittedAssistantRuntime({
  store,
  commands,
  adapters,
  onCommandError,
}: CommittedAssistantRuntimeOptions): AssistantRuntime {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [resync, invalidate] = useReducer((revision: number) => revision + 1, 0);
  const reportCommandError = useCallback(
    (cause: unknown): void => {
      invalidate();
      onCommandError(cause);
    },
    [onCommandError]
  );
  // Branch selection is view state over the committed tree. The installed
  // vendor shows a switched branch only when the repository it is given heads
  // there, so an accepted selection is published as the head until the
  // committed head moves (a new run). The owner's port admits it first: a
  // synchronous refusal throws before anything is selected, and an
  // asynchronous one withdraws exactly the selection it refused.
  const [selection, select] = useState<{
    readonly committedHeadId: string | null | undefined;
    readonly headId: string | null;
  }>();
  const selecting = useMemo((): CommittedAssistantCommands => {
    const owner = commands.setMessages;
    if (!owner) {
      return commands;
    }
    return {
      ...commands,
      setMessages: (messages) => {
        const result: unknown = owner(messages);
        const accepted = {
          committedHeadId: store.getSnapshot().repository.headId,
          headId: messages.at(-1)?.id ?? null,
        };
        select(accepted);
        // The bound port reports the refusal; this only withdraws the selection.
        void Promise.resolve(result).catch(() =>
          select((current) => (current === accepted ? undefined : current))
        );
        return result;
      },
    };
  }, [commands, store]);
  // One tracker per mounted conversation, so a rebound port still sees a run
  // command dispatched through the previous binding.
  const [starts] = useState(() => new CommittedRunStarts());
  const isStarting = useSyncExternalStore(starts.subscribe, starts.isStarting, starts.isStarting);
  const ports = useMemo(
    () => bindCommittedAssistantCommands(store, selecting, reportCommandError, starts),
    [store, selecting, reportCommandError, starts]
  );
  const selectedHeadId =
    selection && selection.committedHeadId === snapshot.repository.headId
      ? selection.headId
      : snapshot.repository.headId;
  // Branch/import can move the vendor's local head before a rejected command.
  // A fresh repository envelope forces its public snapshot path to adopt the
  // canonical fold again. Message/part/approval objects are never copied.
  // The envelope's identity is the signal, so it is state rather than a memo:
  // the React Compiler memoizes on what a body reads and would drop the
  // connection, error and resync triggers, which the envelope never reads.
  const inputs: EnvelopeInputs = [
    snapshot.repository,
    selectedHeadId,
    snapshot.connection,
    snapshot.error,
    resync,
  ];
  const [published, publish] = useState(() => ({
    inputs,
    repository: repositoryEnvelope(snapshot.repository, selectedHeadId),
  }));
  let repository = published.repository;
  if (inputs.some((input, index) => !Object.is(input, published.inputs[index]))) {
    repository = repositoryEnvelope(snapshot.repository, selectedHeadId);
    publish({ inputs, repository });
  }
  const queue = useCommittedMessageQueue(store, ports.onNew, snapshot.isRunning);
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    ...ports,
    adapters,
    extras: snapshot.extras,
    isDisabled: snapshot.isDisabled,
    isLoading: snapshot.isLoading,
    isRunning: snapshot.isRunning,
    // A send while a run command is in flight would reach the host as a
    // refused start (BST-1981), unless the fold already shows that run: then
    // the composer's sends go to the queue and wait for its end.
    isSendDisabled:
      (isStarting && !snapshot.isRunning) ||
      snapshot.connection !== 'connected' ||
      snapshot.error !== undefined,
    messageRepository: repository,
    queue: queue.adapter,
    // Installed branch switching checks this port before moving its local head.
    setMessages:
      snapshot.connection === 'connected' && snapshot.error === undefined && !snapshot.isDisabled
        ? ports.setMessages
        : undefined,
    state: snapshot.state,
  });
  // Declared after the runtime so it runs after the vendor adopts this render's
  // store: a queued message dispatched here is parented on the final reply.
  useEffect(queue.flush);
  return runtime;
}

interface QueueObservation {
  readonly running: boolean;
  readonly settled: boolean;
}

function observeSnapshot(snapshot: CommittedAssistantSnapshot): QueueObservation {
  return {
    running: snapshot.isRunning,
    // A replay that is still loading, or an owner that is not connected, is
    // not a committed state: an idle-looking view there is not a run end.
    settled:
      !snapshot.isLoading && snapshot.connection === 'connected' && snapshot.error === undefined,
  };
}

/**
 * Binds the thread's message queue (`thread-message-queue.ts`) to this
 * conversation. Run edges are read from every committed publication, never
 * from a rendered `isRunning` (BST-2207), and applied after the vendor runtime
 * has rendered that publication. The vendor gets the queue only while a run is
 * active or messages wait (owner decision 2026-10-27): an idle send goes
 * straight to the owner, so a refused one restores its draft.
 */
function useCommittedMessageQueue(
  store: CommittedAssistantStore,
  send: (message: AppendMessage) => Promise<void>,
  isRunning: boolean
): {
  readonly adapter: ExternalThreadQueueAdapter | undefined;
  readonly flush: () => void;
} {
  const queue = threadMessageQueue(store.threadId);
  const items = useSyncExternalStore(queue.subscribe, queue.getItems, queue.getItems);
  const [, observed] = useReducer((count: number) => count + 1, 0);
  const pending = useRef<QueueObservation[]>([]);
  const caughtUp = useRef(false);
  // Bound once per queue: a new send port is not a new binding, so replacing
  // the commands never re-holds a queue that no new observation would release.
  const sendLatest = useEffectEvent(send);
  useEffect(() => queue.bind((message) => sendLatest(message)), [queue]);
  useEffect(() => {
    let last: QueueObservation | undefined;
    const record = (): void => {
      const next = observeSnapshot(store.getSnapshot());
      if (last?.running === next.running && last.settled === next.settled) {
        return;
      }
      last = next;
      pending.current.push(next);
      observed();
    };
    record();
    return store.subscribe(record);
  }, [store]);
  const flush = (): void => {
    for (const observation of pending.current.splice(0)) {
      // The first settled view after mounting is the run end this queue
      // missed while the thread was off screen, if it shows the thread idle.
      const catchUp = observation.settled && !caughtUp.current;
      caughtUp.current ||= observation.settled;
      queue.observe({ ...observation, catchUp });
    }
  };
  return { adapter: isRunning || items.length > 0 ? queue.adapter : undefined, flush };
}
