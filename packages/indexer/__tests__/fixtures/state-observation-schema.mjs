import {
  Memory,
  parseObservationGroups,
} from '@brainstrike/agent/test-fixtures/observation-memory';

export { messages, schema, text } from './state-message-schema.mjs';

class NativeChunks extends Memory {
  /** @param {string} text */
  chunks(text) {
    return this.chunkText(text);
  }
}
const chunker = new NativeChunks({ options: { semanticRecall: false } });
/** @param {string} text @returns {readonly string[]} */
export function observationChunks(text) {
  return chunker.chunks(text);
}

/** @param {import('@brainstrike/state-store').MemoryObservationRecord} record
 * @returns {readonly import('@brainstrike/indexer').StateObservationGroup[]} */
export function observations(record) {
  const p = record.payload;
  const texts = [p.activeObservations, p.bufferedObservations, p.bufferedReflection];
  if (Array.isArray(p.bufferedObservationChunks)) {
    for (const chunk of p.bufferedObservationChunks) {
      if (typeof chunk === 'object' && chunk !== null && 'observations' in chunk) {
        texts.push(chunk.observations);
      }
    }
  }
  const result = [];
  for (const text of texts) {
    if (typeof text !== 'string' || !text) {
      continue;
    }
    const sections =
      record.threadId === null
        ? [...text.matchAll(/<thread id="([^"]+)">([\s\S]*?)<\/thread>/g)].map((match) => ({
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
