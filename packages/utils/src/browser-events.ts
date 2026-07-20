/**
 * Shared window CustomEvent contract for the embedding queue + embedding-set
 * lifecycle (BST-580).
 *
 * These events are dispatched in one package and listened to in others
 * (file-import / app-shell / vector-management dispatch; db-explorer /
 * preferences / app-shell / vector-management listen), so the event names and
 * detail shapes are a wire contract. Before this module existed the three
 * 'queue-drained' dispatchers had drifted to divergent detail shapes; this
 * module is now the single owner of the names, the detail interfaces, and the
 * dispatch/listen helpers.
 *
 * Spelling one of these event names as a string literal anywhere else in the
 * repo fails the lint lane (scripts/browser-events-literal-guard.mjs) — import
 * from '@brainstrike/utils/browser-events' instead.
 *
 * All helpers are no-ops in windowless runtimes (workers / Node), matching the
 * guards every historical dispatcher carried.
 */

export const QUEUE_DRAINED_EVENT = 'brainstrike:queue-drained' as const;
export const QUEUE_PROGRESS_EVENT = 'brainstrike:queue-progress' as const;
export const EMBEDDING_SET_UPDATED_EVENT = 'brainstrike:embedding-set-updated' as const;

/**
 * Detail for {@link QUEUE_DRAINED_EVENT}. Superset of the historical dispatch
 * shapes: `embeddingSetId` is null when the drained queue was not scoped to a
 * specific embedding set, and legacy call sites may dispatch with no detail at
 * all (listeners receive `null` — see {@link onQueueDrained}).
 */
export interface QueueDrainedEventDetail {
  readonly embeddingSetId: string | null;
  readonly queue: 'embeddings';
}

/** Detail for {@link QUEUE_PROGRESS_EVENT} (moved from @brainstrike/file-import). */
export interface QueueProgressEventDetail {
  readonly chunkId: string;
  readonly elapsedMs?: number;
  readonly embeddingSetId: string | null;
  readonly errorMessage?: string;
  readonly failed: number;
  readonly lastError: string | null;
  readonly model: string;
  readonly pending: number;
  readonly processed: number;
  readonly queue: 'embeddings';
  readonly status: 'queued' | 'completed' | 'error';
  readonly totalQueued: number;
}

/** Collection snapshot carried by {@link EmbeddingSetUpdatedEventDetail}. */
export interface EmbeddingSetEventCollection {
  category: string | null;
  chunkCount: number;
  createdAt: string;
  description: string | null;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  embeddingCount: number;
  fileCount: number;
  id: string;
  modelId: string;
  modelKey: string;
  name: string | null;
  statsAvailable?: boolean;
  statsLastRefreshedAt?: string | null;
  tags: string | null;
}

/** Detail for {@link EMBEDDING_SET_UPDATED_EVENT} (moved from @brainstrike/vector-management). */
export interface EmbeddingSetUpdatedEventDetail {
  collection?: EmbeddingSetEventCollection;
  id: string | null;
  reason: 'created' | 'deleted' | 'selected' | 'updated';
}

function dispatchBrowserEvent<TDetail>(eventName: string, detail: TDetail | undefined): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    detail === undefined ? new CustomEvent(eventName) : new CustomEvent(eventName, { detail })
  );
}

/**
 * Subscribe to a browser event; returns the unsubscribe function (safe to
 * return directly from a React effect). `detail` is `null` for detail-less
 * dispatches (the CustomEvent default).
 */
function listenToBrowserEvent<TDetail>(
  eventName: string,
  handler: (detail: TDetail | null) => void
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  const listener = (event: Event): void => {
    handler((event as CustomEvent<TDetail | null>).detail);
  };
  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener(eventName, listener);
  };
}

/** Announce that the embedding queue drained. Omit `detail` only from legacy unscoped call sites. */
export function dispatchQueueDrained(detail?: QueueDrainedEventDetail): void {
  dispatchBrowserEvent(QUEUE_DRAINED_EVENT, detail);
}

export function onQueueDrained(
  handler: (detail: QueueDrainedEventDetail | null) => void
): () => void {
  return listenToBrowserEvent(QUEUE_DRAINED_EVENT, handler);
}

export function dispatchQueueProgress(detail: QueueProgressEventDetail): void {
  dispatchBrowserEvent(QUEUE_PROGRESS_EVENT, detail);
}

export function onQueueProgress(
  handler: (detail: QueueProgressEventDetail | null) => void
): () => void {
  return listenToBrowserEvent(QUEUE_PROGRESS_EVENT, handler);
}

export function dispatchEmbeddingSetUpdated(detail: EmbeddingSetUpdatedEventDetail): void {
  dispatchBrowserEvent(EMBEDDING_SET_UPDATED_EVENT, detail);
}

export function onEmbeddingSetUpdated(
  handler: (detail: EmbeddingSetUpdatedEventDetail | null) => void
): () => void {
  return listenToBrowserEvent(EMBEDDING_SET_UPDATED_EVENT, handler);
}
