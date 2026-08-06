/**
 * The production hard-delete seam for Conversation Rewind finalization
 * (BST-1115, W5 T4b).
 *
 * The delete MUST go through `PgliteMemoryStore.deleteMessages` — Mastra's own
 * storage API, overridden in `packages/agent/src/pglite-mastra-memory/
 * memory-store.ts`. A raw `DELETE FROM mastra_messages` here would be a second
 * writer of a table Mastra owns, and would bypass whatever that override grows
 * to do (index/GC reaping is already the documented reason the Explorer search
 * repository leaves tombstoned index rows in place — see
 * `docs/agents/assistant-persistence.md`).
 *
 * A BARE store is deliberate and sufficient. `createPgliteMastraMemory` also
 * builds a vector store, a workflows store and a `Memory` instance, and THROWS
 * without an embedder when semantic recall or vector retrieval is configured —
 * none of which finalization needs, and any of which would turn a cleanup into
 * a hard failure that depends on the user's memory settings. `deleteMessages`
 * reads only the store's database handle, so this constructs exactly that.
 *
 * `init()` is NOT called: it creates the Mastra schema, and finalization only
 * ever runs against a thread whose messages already exist. Creating tables as
 * a side effect of a delete would be a bootstrap path nobody asked for.
 *
 * The import is dynamic for the same reason `mastra-memory.ts` uses one:
 * `@brainstrike/agent/pglite-mastra-memory` pulls in `@mastra/core`, and the
 * `changes` IPC domain is registered at module load in a process that must not
 * pay for Mastra unless a rewind is actually finalized.
 */
import type { PgliteDatabase } from '@brainstrike/agent/pglite-mastra-memory';
import type { RewindFinalizationDeps } from './rewind-service';

export function createRewindFinalizationDeps(database: PgliteDatabase): RewindFinalizationDeps {
  return {
    deleteMessages: async (messageIds: readonly string[]): Promise<void> => {
      if (messageIds.length === 0) {
        return;
      }
      const { PgliteMemoryStore } = await import('@brainstrike/agent/pglite-mastra-memory');
      const store = new PgliteMemoryStore({ database });
      await store.deleteMessages([...messageIds]);
    },
  };
}
