import type {
  AssistantMemoryThread,
  AssistantThreadCatalogRepository,
  AssistantThreadMetadata,
} from './assistant-memory-repository';
import { mergeAssistantThreadMetadata } from './assistant-thread-metadata-merge';

/**
 * A thread's icon and colour, the keys a customization click changes (BST-2116).
 * They paint at once and are written after; a failed write puts them back.
 */
export type AssistantThreadAppearancePatch = Pick<AssistantThreadMetadata, 'color' | 'icon'>;

const APPEARANCE_KEYS = ['color', 'icon'] as const;
type AppearanceKey = (typeof APPEARANCE_KEYS)[number];

/**
 * A thread appearance write failed. `rolledBack` says whether the store put the
 * shown value back; it does not when a newer pick of the same key is still in
 * flight, since that pick decides what the thread shows.
 */
export class AssistantThreadAppearanceSaveError extends Error {
  readonly rolledBack: boolean;

  constructor(rolledBack: boolean, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'AssistantThreadAppearanceSaveError';
    this.rolledBack = rolledBack;
  }
}

/** One key's writes in flight: the last value the repository accepted, and the newest pick. */
interface KeyWrites {
  durable: AssistantThreadMetadata[AppearanceKey];
  durableToken: number;
  inflight: number;
  latest: number;
}

export interface AppearanceWrite {
  readonly keys: readonly AppearanceKey[];
  readonly patch: AssistantThreadAppearancePatch;
  readonly threadId: string;
  readonly token: number;
}

/**
 * Tracks the optimistic appearance writes of every thread, so a failed write
 * reverts a key to what the repository last accepted, unless a newer pick of
 * that key is still in flight. A single writer applies a thread's writes in
 * the order they were issued, so a newer token's success is the durable value.
 */
export function createAssistantThreadAppearanceWrites() {
  const writes = new Map<string, KeyWrites>();
  let tokens = 0;
  const slot = (threadId: string, key: AppearanceKey): string => `${threadId}\u0000${key}`;
  return {
    begin(
      threadId: string,
      patch: AssistantThreadAppearancePatch,
      current: AssistantThreadMetadata | undefined
    ): AppearanceWrite {
      const extra = Object.keys(patch).filter(
        (key) => !(APPEARANCE_KEYS as readonly string[]).includes(key)
      );
      if (extra.length > 0) {
        throw new Error(
          `A thread appearance patch carries only icon and color: ${extra.join(', ')}`
        );
      }
      tokens += 1;
      const keys = APPEARANCE_KEYS.filter((key) => patch[key] !== undefined);
      for (const key of keys) {
        const entry = writes.get(slot(threadId, key)) ?? {
          durable: current?.[key],
          durableToken: 0,
          inflight: 0,
          latest: 0,
        };
        entry.inflight += 1;
        entry.latest = tokens;
        writes.set(slot(threadId, key), entry);
      }
      return { keys, patch, threadId, token: tokens };
    },
    /** The values to put back after a failed write: only keys no newer pick owns. */
    failed(write: AppearanceWrite): Partial<Record<AppearanceKey, unknown>> | null {
      const revert: Partial<Record<AppearanceKey, unknown>> = {};
      for (const key of write.keys) {
        const entry = writes.get(slot(write.threadId, key));
        if (entry && entry.latest === write.token) {
          revert[key] = entry.durable;
        }
      }
      return Object.keys(revert).length > 0 ? revert : null;
    },
    settled(write: AppearanceWrite): void {
      for (const key of write.keys) {
        const entry = writes.get(slot(write.threadId, key));
        if (entry) {
          entry.inflight -= 1;
          if (entry.inflight === 0) {
            writes.delete(slot(write.threadId, key));
          }
        }
      }
    },
    /** The repository accepted the write. */
    succeeded(write: AppearanceWrite): void {
      for (const key of write.keys) {
        const entry = writes.get(slot(write.threadId, key));
        if (entry && write.token > entry.durableToken) {
          entry.durable = write.patch[key];
          entry.durableToken = write.token;
        }
      }
    },
  };
}

/** `metadata` with `revert` applied: an undefined value removes its key. */
export function revertAssistantThreadAppearance(
  metadata: AssistantThreadMetadata | undefined,
  revert: Partial<Record<AppearanceKey, unknown>>
): AssistantThreadMetadata {
  const next: Record<string, unknown> = { ...(metadata ?? {}) };
  for (const [key, value] of Object.entries(revert)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next as AssistantThreadMetadata;
}

interface ThreadsByResource {
  readonly threadsByResourceId: Record<string, AssistantMemoryThread[]>;
}

/**
 * The store's `updateThreadAppearance`: the patch shows at once, then is
 * written; a failed write puts back the keys no newer pick owns and rejects
 * with `AssistantThreadAppearanceSaveError`.
 */
export function createUpdateThreadAppearance(
  get: () => ThreadsByResource,
  set: (update: (state: ThreadsByResource) => ThreadsByResource) => void
) {
  const writes = createAssistantThreadAppearanceWrites();
  return async (
    repository: Pick<AssistantThreadCatalogRepository, 'updateThreadMetadata'>,
    resourceId: string,
    threadId: string,
    patch: AssistantThreadAppearancePatch
  ): Promise<void> => {
    const mapThread = (
      next: (metadata: AssistantThreadMetadata | undefined) => AssistantThreadMetadata
    ): void =>
      set((state) => ({
        threadsByResourceId: {
          ...state.threadsByResourceId,
          [resourceId]: (state.threadsByResourceId[resourceId] ?? []).map((thread) =>
            thread.id === threadId ? { ...thread, metadata: next(thread.metadata) } : thread
          ),
        },
      }));
    const current = (get().threadsByResourceId[resourceId] ?? []).find(
      (thread) => thread.id === threadId
    );
    const write = writes.begin(threadId, patch, current?.metadata);
    mapThread((metadata) => mergeAssistantThreadMetadata(metadata, patch));
    try {
      await repository.updateThreadMetadata(threadId, patch);
      writes.succeeded(write);
    } catch (cause) {
      const revert = writes.failed(write);
      if (revert) {
        mapThread((metadata) => revertAssistantThreadAppearance(metadata, revert));
      }
      throw new AssistantThreadAppearanceSaveError(revert !== null, cause);
    } finally {
      writes.settled(write);
    }
  };
}
