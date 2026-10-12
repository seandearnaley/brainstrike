import type { StateObservationGroup } from '@brainstrike/indexer';
import type { MemoryObservationRecord } from '@brainstrike/state-store';
import { parseObservationGroups } from '@mastra/memory/processors';
import { chunkStateObservationText } from './adapters/state-store-observation-memory.js';

/** Only the existing persisted native record supplies group attribution. */
function observationSections(
  text: string,
  threadId: string | null
): readonly { readonly text: string; readonly threadId: string }[] {
  if (threadId !== null) {
    return [{ text, threadId }];
  }
  // Memory 1.32.1 exposes group parsing, but not resource thread attribution.
  // Read its persisted thread wrapper; group IDs/ranges still come from the
  // public primitive. Remove when a public resource-attribution reader ships.
  // https://github.com/mastra-ai/mastra/tree/@mastra/memory@1.32.1/packages/memory
  return [...text.matchAll(/<thread id="([^"]+)">([\s\S]*?)<\/thread>/gu)].map((match) => {
    const attributedThread = match[1];
    const content = match[2];
    if (!(attributedThread && content)) {
      throw new Error('Native observation section has no persisted attribution');
    }
    return { text: content, threadId: attributedThread };
  });
}

/** The indexer checks every claim against the same read transaction's owners. */
export function observations(record: MemoryObservationRecord): readonly StateObservationGroup[] {
  const payload = record.payload;
  const candidates: unknown[] = [
    payload['activeObservations'],
    payload['bufferedObservations'],
    payload['bufferedReflection'],
  ];
  const buffered = payload['bufferedObservationChunks'];
  if (Array.isArray(buffered)) {
    for (const chunk of buffered) {
      if (chunk !== null && typeof chunk === 'object' && 'observations' in chunk) {
        candidates.push(chunk.observations);
      }
    }
  }
  return candidates.flatMap((candidate) => {
    if (typeof candidate !== 'string' || !candidate) {
      return [];
    }
    return observationSections(candidate, record.threadId).flatMap((section) =>
      parseObservationGroups(section.text).map((group) => ({
        groupId: group.id,
        range: group.range,
        text: group.content,
        threadId: section.threadId,
      }))
    );
  });
}

/** Exact public Memory chunks; the borrowed adapter owns this sole helper. */
export const observationChunks = chunkStateObservationText;
