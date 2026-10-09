import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import type { OmMeterState } from '@brainstrike/assistant-ui';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

type MemoryRead = HostResults['thread/memory/read'];

/** The committed rows a host thread view publishes. */
export interface HostMemoryRowSource {
  getSnapshot(): { readonly rows: readonly HostLogRow[] };
  subscribe(listener: () => void): () => void;
}

/** The meter's memory segment and the send gate that `thread/memory/read` answers. */
export interface HostMemorySegment {
  /** Why `run/start` would refuse the next send; it gates the composer. */
  readonly admissionReason?: string;
  readonly omSegment?: OmMeterState;
}

/** Map a ready read onto the meter's existing memory states. */
export function hostOmMeterState(
  observational: Extract<MemoryRead, { admission: { ready: true } }>['observational']
): OmMeterState {
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
    messageTokenThreshold: record.messageTokenThreshold,
    observationTokens: record.observationTokenCount,
    pendingMessageTokens: record.pendingMessageTokens,
  };
}

interface ComposerNotice {
  readonly disabledReason?: string;
  readonly isComposerDisabled?: boolean;
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

/** Whether rows past the ones already seen include a memory call or a run's end. */
function memoryChangedSince(rows: readonly HostLogRow[], seen: number): boolean {
  return rows
    .slice(seen)
    .some(({ event }) => event.type === 'memory.usage' || event.type === 'run.finished');
}

async function readSegment(
  client: Pick<HostClient, 'request'>,
  request: HostParams<'thread/memory/read'>
): Promise<HostMemorySegment> {
  const result = await client.request('thread/memory/read', request);
  if ('observational' in result) {
    return { omSegment: hostOmMeterState(result.observational) };
  }
  return { admissionReason: result.admission.reason };
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
          this.#publish({
            omSegment: {
              kind: 'error',
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          });
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
  return segment;
}
