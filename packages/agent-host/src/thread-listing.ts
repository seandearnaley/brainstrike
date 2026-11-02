import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { createLogger } from '@brainstrike/logging';
import type { StateStore } from '@brainstrike/state-store';
import { nodeHostRowReader } from './event-storage.ts';
import { foldLatestRun, type LatestRunFold } from './ledger-projection.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { decodeThread, type HostRowReader, type ListedThread } from './thread-catalog.ts';
import {
  foldHostThreadPresentation,
  type HostThreadPresentation,
} from './thread-presentation-state.ts';

const logger = createLogger('HostThreadListing');

/**
 * The event types the thread list's facts fold from: a child's origin, the presentation, the folder binding and the
 * latest run with its open decisions. Every other row (model steps, streamed text, tool output) is history the list
 * never shows.
 */
const HOST_LISTED_EVENT_TYPES = [
  'interaction.requested',
  'interaction.responded',
  'run.finished',
  'run.started',
  'thread.started',
  'thread.updated',
  'workspace.binding.updated',
] as const satisfies readonly HostEvent['type'][];

interface ListedFacts {
  binding: ThreadWorkspaceBinding | null;
  child: boolean;
  latest: LatestRunFold | undefined;
  presentation: HostThreadPresentation | undefined;
}

function foldListed(facts: ListedFacts, row: HostLogRow): void {
  const { event } = row;
  if (event.type === 'thread.started') {
    facts.child ||= 'origin' in event;
  } else if (event.type === 'thread.updated') {
    facts.presentation = foldHostThreadPresentation(facts.presentation, event);
  } else if (event.type === 'workspace.binding.updated') {
    facts.binding = event.binding;
  }
  facts.latest = foldLatestRun(facts.latest, row);
}

/**
 * The list's own facts from one read of every thread's listed rows, each folded as Core folds it from the same
 * committed rows.
 */
async function readHostThreadListing(
  store: Pick<StateStore, 'readHydration'>,
  rows: HostRowReader
): Promise<ListedThread[]> {
  const started = performance.now();
  const listed: ListedThread[] = [];
  let rowCount = 0;
  for (const stored of await store.readHydration(HOST_LISTED_EVENT_TYPES)) {
    const facts: ListedFacts = {
      binding: null,
      child: false,
      latest: undefined,
      presentation: undefined,
    };
    const decoded = await decodeThread(rows, stored);
    const folded = 'damage' in decoded ? (decoded.head ? [decoded.head] : []) : decoded.rows;
    for (const row of folded) {
      foldListed(facts, row);
    }
    rowCount += folded.length;
    if (!facts.child) {
      const { createdAt, threadId, updatedAt } = stored;
      listed.push({
        threadId,
        ...facts.presentation,
        createdAt,
        updatedAt,
        ...('damage' in decoded ? { damage: decoded.damage } : {}),
        binding: facts.binding,
        ...(facts.latest ? { latestRun: facts.latest.run } : {}),
      });
    }
  }
  logger.info('Listed threads before the full fold', {
    listed: listed.length,
    rows: rowCount,
    totalMs: Math.round(performance.now() - started),
  });
  return listed;
}

/**
 * `thread/list` before Core has folded its log (owner decision 2026-11-02), so the time to the list no longer grows
 * with each thread's history. Until Core's fold and run recovery are done the list answers from the narrow read; from
 * then on, Core's own list answers (a recovered run has finished since, and a row only the full read checks may show
 * damage), and the window re-reads it then.
 */
export class HostThreadListing {
  private early: Promise<ListedThread[]> | undefined;
  private folded = false;

  /**
   * Starts the narrow read, then Core's fold (`hydrate`): the store's writer answers in order, so the list arrives
   * first. Returns the fold, which Core's owners join; a failed fold leaves the narrow list answering until they fail
   * the host.
   */
  start(
    store: Pick<StateStore, 'readHydration'> & Parameters<typeof nodeHostRowReader>[0],
    hydrate: () => Promise<void>
  ): Promise<void> {
    this.early = readHostThreadListing(store, nodeHostRowReader(store));
    this.early.catch(() => undefined);
    const hydrated = hydrate();
    hydrated.then(
      () => {
        this.folded = true;
      },
      () => undefined
    );
    return hydrated;
  }

  /** The narrow list until Core's fold settles, then `folded`, Core's own list. */
  async read(folded: () => ListedThread[]): Promise<ListedThread[]> {
    if (!this.folded) {
      if (!this.early) {
        throw new Error('The thread listing was never started');
      }
      const early = await this.early;
      if (!this.folded) {
        return early;
      }
    }
    return folded();
  }
}
