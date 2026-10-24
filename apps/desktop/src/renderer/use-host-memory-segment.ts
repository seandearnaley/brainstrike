import type { HostClient } from '@brainstrike/agent-host/browser';
import type {
  HostLogRow,
  HostMemoryCycleEvent,
  HostMemoryModels,
  HostParams,
  HostResults,
  HostRunTelemetry,
} from '@brainstrike/agent-host/protocol';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import {
  BoundaryFailureError,
  describeBoundaryError,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import { readMemoryRecallTelemetry } from '@brainstrike/assistant-contract/tool-telemetry';
import type {
  MemoryCycleDisplay,
  MemoryCyclesDisplay,
  MemoryModelsDisplay,
  MemoryRecallDisplay,
  OmMeterState,
} from '@brainstrike/assistant-ui';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

type MemoryRead = HostResults['thread/memory/read'];

/** The committed rows a host thread view publishes, and its live telemetry. */
export interface HostMemoryRowSource {
  getSnapshot(): { readonly rows: readonly HostLogRow[] };
  /** The thread's uncommitted `run/telemetry` (ADR-0011 amendment); BST-2225 reads recalls from it. */
  onTelemetry?(listener: (telemetry: HostRunTelemetry) => void): () => void;
  subscribe(listener: () => void): () => void;
}

/** The meter's memory segment and the send gate that `thread/memory/read` answers. */
export interface HostMemorySegment {
  /** Why `run/start` would refuse the next send; it gates the composer. */
  readonly admissionReason?: string;
  readonly omSegment?: OmMeterState;
}

type ReadyRead = Extract<MemoryRead, { admission: { ready: true } }>;

/** Map a ready read onto the meter's memory states; a host that predates it reports no lifecycle. */
export function hostOmMeterState(observational: ReadyRead['observational']): OmMeterState {
  if (observational.state === 'off') {
    return { kind: 'inactive' };
  }
  if (observational.state === 'awaiting-observer') {
    return { kind: 'awaiting-observer', reason: observational.reason };
  }
  const { record } = observational;
  if (record === null) {
    return { kind: 'empty' };
  }
  return {
    bufferedObservationTokens: record.bufferedObservationTokens,
    compactionSavedTokens: Math.max(0, record.totalTokensObserved - record.observationTokenCount),
    kind: 'stats',
    ...(record.lifecycle ? { lifecycle: record.lifecycle } : {}),
    messageTokenThreshold: record.messageTokenThreshold,
    observationTokens: record.observationTokenCount,
    pendingMessageTokens: record.pendingMessageTokens,
  };
}

interface ComposerNotice {
  readonly disabledReason?: string | undefined;
  readonly isComposerDisabled?: boolean | undefined;
}

/**
 * The composer presentation once Memory has answered: a notice that already
 * gates the send stays first; otherwise a memory precondition `run/start`
 * would refuse gates the send, ahead of an advisory notice.
 */
export function withMemoryGate<Presentation extends ComposerNotice>(
  presentation: Presentation,
  segment: HostMemorySegment
): Presentation {
  if (presentation.isComposerDisabled === true || segment.admissionReason === undefined) {
    return presentation;
  }
  return { ...presentation, disabledReason: segment.admissionReason, isComposerDisabled: true };
}

/**
 * Whether rows past the ones already seen change what Memory holds: a memory
 * call or cycle, a run's end, or a failed settlement. A failed buffered cycle
 * commits before Mastra clears its buffering flag; the settlement's failure
 * commits after, so its read sees the record settled.
 */
function memoryChangedSince(rows: readonly HostLogRow[], seen: number): boolean {
  return rows
    .slice(seen)
    .some(
      ({ event }) =>
        event.type === 'memory.usage' ||
        event.type === 'memory.cycle' ||
        event.type === 'memory.settlement.failed' ||
        event.type === 'run.finished'
    );
}

/** A committed cycle's facts as the meter shows them, with when it committed. */
function memoryCycleDisplay(
  { durationMs, failure, outcome, trigger, usage }: HostMemoryCycleEvent,
  at: number | undefined
): MemoryCycleDisplay {
  return {
    ...(at === undefined ? {} : { at }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failure === undefined
      ? {}
      : {
          failure: {
            code: failure.code,
            ...(failure.correlationId === undefined
              ? {}
              : { correlationId: failure.correlationId }),
          },
        }),
    outcome,
    ...(trigger === undefined ? {} : { trigger }),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
          },
        }),
  };
}

/** The models a read named, as the meter shows them. */
function memoryModelsDisplay({ embedder, observer }: HostMemoryModels): MemoryModelsDisplay {
  return {
    ...(embedder === undefined
      ? {}
      : {
          embedder: {
            dimensions: embedder.dimensions,
            distance: embedder.distance,
            ...(embedder.dtype === undefined ? {} : { dtype: embedder.dtype }),
            modelId: embedder.modelId,
            provider: embedder.provider,
          },
        }),
    ...(observer === undefined ? {} : { observer }),
  };
}

/** The thread's last committed cycle of each kind (BST-2224), with when it committed. */
export function lastMemoryCycles(rows: readonly HostLogRow[]): MemoryCyclesDisplay | undefined {
  let observation: MemoryCycleDisplay | undefined;
  let reflection: MemoryCycleDisplay | undefined;
  for (const { event, ts } of rows) {
    if (event.type !== 'memory.cycle') {
      continue;
    }
    const cycle = memoryCycleDisplay(event, ts);
    if (event.kind === 'observation') {
      observation = cycle;
    } else {
      reflection = cycle;
    }
  }
  if (!(observation || reflection)) {
    return;
  }
  return { ...(observation ? { observation } : {}), ...(reflection ? { reflection } : {}) };
}

const NO_ROWS: readonly HostLogRow[] = [];
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

async function readSegment(
  client: Pick<HostClient, 'request'>,
  request: HostParams<'thread/memory/read'>
): Promise<HostMemorySegment> {
  const result = await client.request('thread/memory/read', request);
  if ('observational' in result) {
    // The record as of this read: no committed row marks Mastra's background
    // work ending, so its live flags hold until the next read.
    const state = { ...hostOmMeterState(result.observational), readAt: Date.now() };
    return {
      omSegment: result.models ? { ...state, models: memoryModelsDisplay(result.models) } : state,
    };
  }
  return { admissionReason: result.admission.reason };
}

/** A failed read's validated reason, with the boundary code it arrived under. */
function readFailure(cause: unknown): OmMeterState {
  return {
    code: cause instanceof BoundaryFailureError ? cause.failure.code : INTERNAL_FAULT.code,
    kind: 'error',
    readAt: Date.now(),
    reason: describeBoundaryError(cause),
  };
}

/**
 * One thread view's memory reads: only the latest read publishes (an earlier
 * answer is for older settings), and a request equal by value to the one the
 * published segment answers is read again only when forced.
 */
class HostMemoryReads {
  #segment: HostMemorySegment = {};
  // The request the published segment answers, serialized; undefined while gated.
  #answered: string | undefined;
  #latest = 0;
  readonly #listeners = new Set<() => void>();

  readonly getSnapshot = (): HostMemorySegment => this.#segment;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  read(
    client: Pick<HostClient, 'request'>,
    request: HostParams<'thread/memory/read'> | undefined,
    catalog: string,
    always: boolean
  ): void {
    // Admission also reads the enabled catalog, which the request does not carry.
    const key = request === undefined ? undefined : JSON.stringify([request, catalog]);
    if (!always && key === this.#answered) {
      return;
    }
    this.#answered = key;
    this.#latest += 1;
    const attempt = this.#latest;
    if (request === undefined) {
      this.#publish({});
      return;
    }
    this.#publish({ ...this.#segment, omSegment: { kind: 'loading' } });
    readSegment(client, request).then(
      (next) => {
        if (attempt === this.#latest) {
          this.#publish(next);
        }
      },
      (cause: unknown) => {
        if (attempt === this.#latest) {
          this.#publish({ omSegment: readFailure(cause) });
        }
      }
    );
  }

  #publish(segment: HostMemorySegment): void {
    this.#segment = segment;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * Reads `thread/memory/read` with the request the next `run/start` would send:
 * when the thread opens, when the request it builds changes (model,
 * configuration, plan mode; compared by value, since the thread view's
 * callback changes identity on every render), when the enabled catalog that
 * admission reads changes, when the memory settings change, and after each
 * committed memory call or run end. It never polls.
 * While another notice already gates the send, the request cannot be built,
 * so nothing is read.
 */
export function useHostMemorySegment(options: {
  readonly blocked: boolean;
  /**
   * The enabled catalog models admission reads, which the request does not
   * carry: enabling the selected model must clear its gate.
   */
  readonly catalog: string;
  readonly client: Pick<HostClient, 'request'>;
  readonly readRequest: () => HostParams<'thread/memory/read'>;
  readonly source: HostMemoryRowSource | undefined;
}): HostMemorySegment {
  const { blocked, catalog, client, readRequest, source } = options;
  // An answer that arrives after unmount publishes to a store nothing reads.
  const [reads] = useState(() => new HostMemoryReads());
  const segment = useSyncExternalStore(reads.subscribe, reads.getSnapshot);
  // The thread view replaces its rows array only when rows commit.
  const readRows = useCallback(() => source?.getSnapshot().rows ?? NO_ROWS, [source]);
  const rows = useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIPTION, readRows, readRows);
  const cycles = useMemo(() => lastMemoryCycles(rows), [rows]);
  // BST-2225: the last recall this view saw live. It is never committed, so it
  // belongs to the source that delivered it; another thread starts empty.
  const [seen, setSeen] = useState<{
    readonly recall: MemoryRecallDisplay;
    readonly source: HostMemoryRowSource;
  }>();
  useEffect(() => {
    if (!source?.onTelemetry) {
      return;
    }
    return source.onTelemetry(({ chunk }) => {
      const recall = readMemoryRecallTelemetry(chunk);
      if (recall) {
        setSeen({ recall: { ...recall, at: Date.now() }, source });
      }
    });
  }, [source]);
  const recall = seen && seen.source === source ? seen.recall : undefined;
  const read = useCallback(
    (always: boolean): void => {
      reads.read(client, blocked ? undefined : readRequest(), catalog, always);
    },
    [blocked, catalog, client, readRequest, reads]
  );
  // The thread opened, or the request or its gate may have changed.
  useEffect(() => {
    read(false);
  }, [read]);
  // Memory settings are captured from their store at call time.
  useEffect(() => useAssistantMemoryPreferencesStore.subscribe(() => read(true)), [read]);
  // Each committed memory call or run end changes what Memory holds.
  useEffect(() => {
    if (!source) {
      return;
    }
    let seen = source.getSnapshot().rows.length;
    return source.subscribe(() => {
      const { rows } = source.getSnapshot();
      const changed = rows.length < seen || memoryChangedSince(rows, seen);
      seen = rows.length;
      if (changed) {
        read(true);
      }
    });
  }, [read, source]);
  // Each kind's last committed cycle, and the last recall seen live, join
  // whatever state the read answered.
  return useMemo(
    () =>
      segment.omSegment && (cycles || recall)
        ? {
            ...segment,
            omSegment: {
              ...segment.omSegment,
              ...(cycles ? { cycles } : {}),
              ...(recall ? { recall } : {}),
            },
          }
        : segment,
    [cycles, recall, segment]
  );
}
