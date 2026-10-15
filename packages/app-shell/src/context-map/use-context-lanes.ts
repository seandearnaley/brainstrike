/**
 * BST-2021: a thread's subagents as lanes of its Context tab. The host lists
 * the thread's direct children; each child on the displayed branch is read from
 * its own committed log through the host, folded as its own view folds it.
 * Lanes are read only while the tab shows them.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  type AssistantThreadContextSnapshot,
  type AssistantThreadContextSource,
  type AssistantThreadHostChild,
  useAssistantThreadHost,
} from '../assistant-thread-host-context';

export interface ContextLane {
  readonly child: AssistantThreadHostChild;
  /** The parent turn whose run started the child: its 1-based place on the displayed branch. */
  readonly startedAtTurn: number;
  readonly state: AssistantThreadContextSnapshot;
}

export interface ContextLanes {
  readonly lanes: readonly ContextLane[];
  /** Why the thread's children could not be listed. */
  readonly listError?: string;
  /** Reads a failed lane again. */
  readonly retry: (childThreadId: string) => void;
}

type OpenThreadContext = (threadId: string) => Promise<AssistantThreadContextSource>;

const LOADING: AssistantThreadContextSnapshot = { isLoading: true };
const NO_STATES: ReadonlyMap<string, AssistantThreadContextSnapshot> = new Map();
const NO_LANES: ContextLanes = { lanes: [], retry: () => undefined };

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface LaneEntry {
  closed: boolean;
  release?: () => void;
  source?: AssistantThreadContextSource;
  state: AssistantThreadContextSnapshot;
}

/** One open source per lane; exported for its tests. */
export class ContextLaneSources {
  private readonly entries = new Map<string, LaneEntry>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, AssistantThreadContextSnapshot> = NO_STATES;

  constructor(private readonly open: OpenThreadContext) {}

  readonly getSnapshot = (): ReadonlyMap<string, AssistantThreadContextSnapshot> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reads exactly `threadIds`: opens new lanes, reopens failed ones and closes the rest. */
  sync(threadIds: readonly string[]): void {
    const wanted = new Set(threadIds);
    let changed = false;
    for (const [threadId, entry] of this.entries) {
      if (!wanted.has(threadId)) {
        this.close(entry);
        this.entries.delete(threadId);
        changed = true;
      }
    }
    for (const threadId of wanted) {
      const entry = this.entries.get(threadId);
      if (!entry || entry.state.error !== undefined) {
        if (entry) {
          this.close(entry);
        }
        this.start(threadId);
        changed = true;
      }
    }
    if (changed) {
      this.publish();
    }
  }

  retry(threadId: string): void {
    const entry = this.entries.get(threadId);
    if (entry?.state.error === undefined) {
      return;
    }
    this.close(entry);
    this.start(threadId);
    this.publish();
  }

  /** Closes every lane; subscribers stay, and a later sync reads again. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.close(entry);
    }
    this.entries.clear();
    this.publish();
  }

  private start(threadId: string): void {
    const entry: LaneEntry = { closed: false, state: LOADING };
    this.entries.set(threadId, entry);
    this.open(threadId).then(
      (source) => {
        if (entry.closed) {
          source.close();
          return;
        }
        entry.source = source;
        const update = (): void => {
          entry.state = source.getSnapshot();
          this.publish();
        };
        entry.release = source.subscribe(update);
        update();
      },
      (cause: unknown) => {
        if (!entry.closed) {
          entry.state = { error: describe(cause), isLoading: false };
          this.publish();
        }
      }
    );
  }

  private close(entry: LaneEntry): void {
    entry.closed = true;
    entry.release?.();
    entry.source?.close();
  }

  private publish(): void {
    this.snapshot = new Map([...this.entries].map(([threadId, entry]) => [threadId, entry.state]));
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const readNoStates = (): ReadonlyMap<string, AssistantThreadContextSnapshot> => NO_STATES;

/** The thread's direct children on its displayed branch, each with its lane's read. */
export function useContextLanes(
  threadId: string | null,
  branchRunIds: readonly string[]
): ContextLanes {
  const host = useAssistantThreadHost();
  const list = useMemo(() => host?.childThreads?.bind(host), [host]);
  const open = useMemo(() => host?.openThreadContext?.bind(host), [host]);
  const subscribeChildren = useMemo(() => host?.subscribeChildren?.bind(host), [host]);
  const readable = Boolean(threadId && list && open);

  // The host says when this thread's children changed; nothing is polled.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!(readable && subscribeChildren)) {
      return;
    }
    return subscribeChildren((changed) => {
      if (changed === threadId) {
        setRevision((value) => value + 1);
      }
    });
  }, [readable, subscribeChildren, threadId]);

  const [listed, setListed] = useState<{
    readonly children?: readonly AssistantThreadHostChild[];
    readonly error?: string;
    readonly threadId: string;
  }>();
  useEffect(() => {
    if (!(threadId && list && open)) {
      return;
    }
    let active = true;
    list(threadId).then(
      (children) => {
        if (active) {
          setListed({ children, threadId });
        }
      },
      (cause: unknown) => {
        if (active) {
          setListed({ error: describe(cause), threadId });
        }
      }
    );
    return () => {
      active = false;
    };
    // `revision` re-lists when the host reports a change.
  }, [list, open, threadId, revision]);

  // One set per thread. Constructing opens nothing; the sync below opens lanes,
  // and a disposed set reopens on its next sync (StrictMode's replayed effects).
  const sources = useMemo(
    () => (threadId && open ? new ContextLaneSources(open) : undefined),
    [open, threadId]
  );
  useEffect(() => () => sources?.dispose(), [sources]);

  const current = listed?.threadId === threadId ? listed : undefined;
  const branchKey = branchRunIds.join('\n');
  const onBranch = useMemo(() => {
    const position = new Map(branchKey.split('\n').map((runId, index) => [runId, index + 1]));
    return (current?.children ?? []).flatMap((child) => {
      const startedAtTurn = branchKey ? position.get(child.parentRunId) : undefined;
      return startedAtTurn === undefined ? [] : [{ child, startedAtTurn }];
    });
  }, [branchKey, current]);
  const laneKey = onBranch.map(({ child }) => child.threadId).join('\n');
  useEffect(() => {
    sources?.sync(laneKey ? laneKey.split('\n') : []);
  }, [laneKey, sources]);

  const states = useSyncExternalStore(
    sources?.subscribe ?? NO_SUBSCRIPTION,
    sources?.getSnapshot ?? readNoStates,
    sources?.getSnapshot ?? readNoStates
  );
  return useMemo(() => {
    if (!readable) {
      return NO_LANES;
    }
    return {
      lanes: onBranch.map(({ child, startedAtTurn }) => ({
        child,
        startedAtTurn,
        state: states.get(child.threadId) ?? LOADING,
      })),
      ...(current?.error === undefined ? {} : { listError: current.error }),
      retry: (childThreadId: string) => sources?.retry(childThreadId),
    };
  }, [current, onBranch, readable, sources, states]);
}
