import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostEvent, HostLogRow, HostParams, HostRunSelection } from './protocol.js';

type Updated = Extract<HostEvent, { type: 'thread.selection.updated' }>;

/** Core's single writer and admission queue, lent as thread-rewind.ts borrows them. */
export interface HostThreadSelectionPorts {
  accept(
    threadId: string,
    method: string,
    params: { commandId: string },
    result: Json,
    events: readonly HostEvent[]
  ): Promise<void>;
  command<T extends Json>(
    method: string,
    params: { commandId: string; threadId: string },
    perform: () => Promise<T>
  ): Promise<T>;
  readonly threads: ReadonlySet<string>;
}

function selectionOf(pair: HostRunSelection): HostRunSelection {
  return {
    modelId: pair.modelId,
    ...(pair.configuration ? { configuration: pair.configuration } : {}),
  };
}

/**
 * ADR-0019: each thread's current run selection, folded from every row Core
 * commits. Core is the one writer; a wake admits from this selection.
 */
export class HostThreadSelections {
  private readonly selections = new Map<string, HostRunSelection>();

  constructor(private readonly ports: HostThreadSelectionPorts) {}

  fold(row: HostLogRow): void {
    if (row.event.type === 'thread.selection.updated') {
      this.selections.set(row.threadId, selectionOf(row.event));
    }
  }

  forget(threadId: string): void {
    this.selections.delete(threadId);
  }

  read(threadId: string): { selection: HostRunSelection | null } {
    if (!this.ports.threads.has(threadId)) {
      throw new Error('Unknown thread');
    }
    return { selection: structuredClone(this.selections.get(threadId) ?? null) };
  }

  /** A composer pick commits only when it changes the thread's selection. */
  set(params: HostParams<'thread/selection/set'>): Promise<{ accepted: true }> {
    const method = 'thread/selection/set';
    return this.ports.command(method, params, async () => {
      const result = { accepted: true } as const;
      await this.ports.accept(params.threadId, method, params, result, this.changes(params));
      return result;
    });
  }

  /** The event a run's pair commits: none when the thread's selection already holds it. */
  changes(pair: HostRunSelection & { readonly threadId: string }): Updated[] {
    const selection = selectionOf(pair);
    const current = this.selections.get(pair.threadId);
    if (current && canonical(jsonValue(current)) === canonical(jsonValue(selection))) {
      return [];
    }
    return [{ ...structuredClone(selection), type: 'thread.selection.updated' }];
  }

  /** A wake admits from the thread's committed selection, never from a run's snapshot. */
  forWake(threadId: string): HostRunSelection {
    const selection = this.selections.get(threadId);
    if (!selection) {
      throw new Error('A wake requires the thread’s committed run selection');
    }
    return structuredClone(selection);
  }
}
