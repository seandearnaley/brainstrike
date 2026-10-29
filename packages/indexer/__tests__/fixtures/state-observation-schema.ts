import type { StateObservationGroup } from '@brainstrike/indexer';
import type { MemoryObservationRecord } from '@brainstrike/state-store';
import {
  Memory,
  parseObservationGroups,
} from '@brainstrike/test-utils/fixtures/observation-memory';

export { messages, schema, text } from './state-message-schema.mjs';

class NativeChunks extends Memory {
  constructor(config: { readonly options: { readonly semanticRecall: boolean } }) {
    super(config);
  }
  chunks(text: string): readonly string[] {
    return this['chunkText'](text);
  }
}
const chunker = new NativeChunks({ options: { semanticRecall: false } });
export function observationChunks(text: string): readonly string[] {
  return chunker.chunks(text);
}

export function observations(record: MemoryObservationRecord): readonly StateObservationGroup[] {
  const p = record.payload;
  const texts = [p['activeObservations'], p['bufferedObservations'], p['bufferedReflection']];
  const bufferedChunks = p['bufferedObservationChunks'];
  if (Array.isArray(bufferedChunks)) {
    for (const chunk of bufferedChunks) {
      if (typeof chunk === 'object' && chunk !== null && 'observations' in chunk) {
        texts.push(chunk.observations);
      }
    }
  }
  const result: StateObservationGroup[] = [];
  for (const text of texts) {
    if (typeof text !== 'string' || !text) {
      continue;
    }
    const sections =
      record.threadId === null
        ? [...text.matchAll(/<thread id="([^"]+)">([\s\S]*?)<\/thread>/gu)].map((match) => ({
            text: match[2],
            threadId: match[1],
          }))
        : [{ text, threadId: record.threadId }];
    for (const section of sections) {
      if (!(section.threadId && section.text)) {
        throw new Error('Native fixture has invalid attribution');
      }
      for (const group of parseObservationGroups(section.text)) {
        result.push({
          groupId: group.id,
          range: group.range,
          text: group.content,
          threadId: section.threadId,
        });
      }
    }
  }
  return result;
}
