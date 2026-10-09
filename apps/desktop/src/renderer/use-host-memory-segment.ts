import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow, HostParams, HostResults } from '@brainstrike/agent-host/protocol';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import type { OmMeterState } from '@brainstrike/assistant-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

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
 * Reads `thread/memory/read` with the request the next `run/start` would send:
 * when the thread opens, when `readRequest` changes (a new identity is a new
 * model, configuration or plan mode), when the memory settings change, and
 * after each committed memory call or run end. It never polls. While another
 * notice already gates the send, the request cannot be built, so nothing is
 * read.
 */
export function useHostMemorySegment(options: {
  readonly blocked: boolean;
  readonly client: Pick<HostClient, 'request'>;
  readonly readRequest: () => HostParams<'thread/memory/read'>;
  readonly source: HostMemoryRowSource | undefined;
}): HostMemorySegment {
  const { blocked, client, readRequest, source } = options;
  const [segment, setSegment] = useState<HostMemorySegment>({});
  // Only the latest read may publish; an earlier answer is for older settings.
  const latest = useRef(0);
  const refresh = useCallback((): void => {
    latest.current += 1;
    const attempt = latest.current;
    if (blocked) {
      setSegment({});
      return;
    }
    setSegment((previous) => ({ ...previous, omSegment: { kind: 'loading' } }));
    readSegment(client, readRequest()).then(
      (next) => {
        if (attempt === latest.current) {
          setSegment(next);
        }
      },
      (cause: unknown) => {
        if (attempt === latest.current) {
          setSegment({
            omSegment: {
              kind: 'error',
              reason: cause instanceof Error ? cause.message : String(cause),
            },
          });
        }
      }
    );
  }, [blocked, client, readRequest]);
  // The thread opened, or the request's model, settings, plan mode or gate changed.
  useEffect(() => {
    refresh();
    return () => {
      latest.current += 1;
    };
  }, [refresh]);
  // Memory settings are captured from their store at call time.
  useEffect(() => useAssistantMemoryPreferencesStore.subscribe(refresh), [refresh]);
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
        refresh();
      }
    });
  }, [refresh, source]);
  return segment;
}
