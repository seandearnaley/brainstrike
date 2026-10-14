import { makeLiveQueryKey, usePGliteLiveQuery } from '@brainstrike/db/react';
import { useMemo } from 'react';
import {
  COLLECTION_STATS_QUERY,
  type CollectionStatsRow,
  resolveEffectiveStatsRow,
  toStatsNumber,
} from './collection-stats-query';

/**
 * Named reason shown when the selected set has no embedded chunks yet. This is
 * the ONE honestly-gateable precondition for semantic search from the renderer
 * (see the P3 investigation notes below).
 */
export const SEMANTIC_UNAVAILABLE_NO_CHUNKS =
  'No embedded chunks in this collection yet — indexing may still be running.';

export interface SemanticAvailability {
  /** False when semantic search cannot run for the selected set. */
  available: boolean;
  /** Named reason to surface (tooltip); null when available. */
  reason: string | null;
}

/**
 * Whether semantic search is usable for the selected embedding set, with a
 * named reason when it is not.
 *
 * Reads the SAME live stats rows the picker/coverage-banner already subscribe to
 * (shared {@link COLLECTION_STATS_QUERY}, same cache key) — no new DB surface.
 *
 * ## Gate scope (P3 investigation)
 *
 * The task considered three candidate gates; only (b) is honestly enforceable
 * from the renderer without instantiating an embedder:
 *
 * - **(a) hosted model with no API key — NOT gated here (backstop = error card).**
 *   Key presence is only knowable via the ASYNC keychain/env bridge
 *   (`resolveHostedProviderApiKey` → `window.secrets.getKey(provider)`, then
 *   `process.env`/`import.meta.env` — see
 *   `packages/embeddings/src/providers/hosted/api-key-resolver.ts`). There is no
 *   synchronous renderer-side key-presence signal (no preferences store exposes
 *   it), so a pre-search gate would either lie (stale `apiKeyCache`) or force an
 *   async probe. Per the brief's escape hatch, a missing hosted key stays a
 *   run-time failure surfaced by the existing search error card.
 * - **(b) zero embedded chunks — GATED.** `embeddedChunkCount === 0` on the
 *   effective set means there is nothing to search semantically. This is the
 *   sole gate.
 * - **(c) local runtime unavailable — VACUOUS, so NOT gated.** Local embedding
 *   models run on WASM as well as WebGPU (`createLocalEmbedder(modelConfig,
 *   devicePref)` with `devicePref: 'webgpu' | 'wasm'`; device detection
 *   recommends WASM when no WebGPU adapter is present — see
 *   `packages/embeddings/src/device-detection.ts`). WASM is available whenever
 *   `WebAssembly` is defined, which is always true in a browser/Electron
 *   renderer. The only state that would gate is a missing WASM runtime, which
 *   never occurs here, so implementing (c) would be dead, dishonest code. (This
 *   differs from the built-in local *LLM*, which is WebGPU-only with no WASM
 *   fallback; local *embeddings* are not.)
 *
 * A missing stats row (still loading, or set not found) is treated as available
 * (optimistic) so semantic mode never false-gates on a transient empty read —
 * the error card remains the backstop if a search then fails. The same applies
 * to a set row whose LEFT-JOINed stats columns are NULL (no
 * collection_indexing_stats row yet): that is "unknown", not a confirmed zero
 * — `Number(null)` would otherwise silently read as 0 and false-gate.
 */
export function useSemanticAvailability(
  collectionId: string | null,
  nativeAvailability?: SemanticAvailability
): SemanticAvailability {
  const { rows } = usePGliteLiveQuery<CollectionStatsRow>({
    cacheKey: makeLiveQueryKey('workspace-search-collection-stats'),
    enabled: nativeAvailability === undefined,
    key: 'id',
    mode: 'incremental',
    query: COLLECTION_STATS_QUERY,
  });

  return useMemo<SemanticAvailability>(() => {
    if (nativeAvailability) {
      return nativeAvailability;
    }
    const statsRow = resolveEffectiveStatsRow(rows, collectionId);
    if (!statsRow) {
      return { available: true, reason: null };
    }
    const embeddedChunkCount = statsRow.embeddedChunkCount;
    if (embeddedChunkCount === null || embeddedChunkCount === undefined) {
      return { available: true, reason: null };
    }
    if (toStatsNumber(embeddedChunkCount) === 0) {
      return { available: false, reason: SEMANTIC_UNAVAILABLE_NO_CHUNKS };
    }
    return { available: true, reason: null };
  }, [rows, collectionId, nativeAvailability]);
}
