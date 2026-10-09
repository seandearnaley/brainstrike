import { requiredString } from './committed-host-event-fields';

/**
 * Where a committed rewind leaves a host thread's conversation head, as
 * Core's own fold decides it:
 * - a rewind (or one the host stopped inside) moves the head to the run the
 *   target message followed, or the thread root (`null`);
 * - its redo returns the head to the thread's latest run;
 * - an intent alone does not move it.
 */
export type CommittedRewindHeadMove =
  | { readonly to: 'latest' }
  | { readonly to: 'run'; readonly runId: string | null }
  | { readonly to: 'unchanged' };

const REWIND_EVENTS = new Set<unknown>([
  'thread.rewind.started',
  'thread.rewound',
  'thread.rewind.redo.started',
  'thread.rewind.redone',
  'thread.rewind.interrupted',
]);

export class CommittedRewindHead {
  private latest: { readonly headId: string | null; readonly rewindId: string } | undefined;

  /** The head move for a rewind row; undefined when the row is not a rewind's. */
  fold(event: Readonly<Record<string, unknown>>): CommittedRewindHeadMove | undefined {
    const type = event['type'];
    if (!REWIND_EVENTS.has(type)) {
      return;
    }
    const rewindId = requiredString(event, 'rewindId');
    if (type === 'thread.rewind.started') {
      const headId = event['headId'];
      if (headId !== null && typeof headId !== 'string') {
        throw new Error('Committed rewind has an unsupported head.');
      }
      this.latest = { headId, rewindId };
      return { to: 'unchanged' };
    }
    if (this.latest?.rewindId !== rewindId) {
      throw new Error('Committed rewind outcome has no started rewind.');
    }
    if (type === 'thread.rewound' || type === 'thread.rewind.interrupted') {
      return { runId: this.latest.headId, to: 'run' };
    }
    return type === 'thread.rewind.redone' ? { to: 'latest' } : { to: 'unchanged' };
  }
}
