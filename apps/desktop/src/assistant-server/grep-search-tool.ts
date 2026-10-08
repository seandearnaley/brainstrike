/**
 * Main's grep: the shared search core over Main's own PGlite file-chunk index.
 * The agent host runs the same core with a typed read of this index instead.
 */
import type { GrepSearchInput, RuntimeData } from '@brainstrike/agent';
import { FileChunkRepository, type GrepSearchOptions, GrepSearchService } from '@brainstrike/db';
import type { GrepToolResult } from '@brainstrike/host-capabilities/native-tools';
import { getDatabase } from '../db-main';
import { runGrepSearchWith } from './grep-search-core';

/** The indexed half over Main's PGlite file chunks. */
export async function pgliteGrepIndex(options: GrepSearchOptions) {
  return await new GrepSearchService(new FileChunkRepository(await getDatabase())).search(options);
}

export function runGrepSearch(
  input: GrepSearchInput,
  runtimeData: RuntimeData | undefined
): Promise<GrepToolResult> {
  return runGrepSearchWith(input, runtimeData, pgliteGrepIndex);
}
