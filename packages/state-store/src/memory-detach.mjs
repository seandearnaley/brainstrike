// @ts-check
// Detaching a deleted thread's sections from shared resource observations: pure, no database. The memory calculator
// worker runs it with Mastra OM's token counter (memory-calculator-worker.mjs); the writer commits its result.

const THREAD_SECTION = /<thread id="([^"]+)">[\s\S]*?<\/thread>/gu;

/**
 * Mastra Memory 1.32.1 persists resource-scope observations as
 * `<thread id="...">` sections joined by separators (ObservationStrategy
 * wrapWithThreadTag/replaceOrAppendThreadSection); it exposes no public way to
 * remove one thread's section. Drop that thread's sections, each with the
 * separator before it (after it, for the first), and keep the rest unchanged.
 * Returns the kept [start, end) ranges of `text` in order, or null when no
 * section is the thread's. Known limit: with OM `obscureThreadIds` the tag
 * holds a hash, not the thread ID, so such sections stay; nothing enables it.
 * Remove when Memory offers a public resource-attribution editor.
 * https://github.com/mastra-ai/mastra/tree/@mastra/memory@1.32.1/packages/memory
 * @param {string} text @param {string} threadId
 * @returns {{ start: number; end: number }[] | null} */
function keptRanges(text, threadId) {
  const sections = [...text.matchAll(THREAD_SECTION)].map((match) => ({
    end: match.index + match[0].length,
    owner: match[1],
    start: match.index,
  }));
  if (sections.every((section) => section.owner !== threadId)) {
    return null;
  }
  const kept = [];
  let previousEnd = 0;
  for (const section of sections) {
    if (section.owner !== threadId) {
      kept.push({ end: section.end, start: kept.length === 0 ? section.start : previousEnd });
    }
    previousEnd = section.end;
  }
  if (kept.length === 0) {
    return [];
  }
  const lead = { end: sections[0]?.start ?? 0, start: 0 };
  return [lead, ...kept, { end: text.length, start: previousEnd }];
}

/** @param {string} text @param {{ start: number; end: number }[]} ranges */
function joinRanges(text, ranges) {
  return ranges.map(({ end, start }) => text.slice(start, end)).join('');
}

/**
 * Mastra activates a buffered reflection over the first
 * `reflectedObservationLineCount` lines of the active observations. Count the
 * lines of the detached text that hold what is left of that prefix.
 * @param {string} before @param {string} after
 * @param {{ start: number; end: number }[]} ranges @param {number} lines */
function reflectedLinesAfter(before, after, ranges, lines) {
  const prefix = before.split('\n').slice(0, lines).join('\n').length;
  const left = ranges.reduce(
    (sum, { end, start }) => sum + Math.max(0, Math.min(end, prefix) - start),
    0
  );
  return left === 0 ? 0 : after.slice(0, left - 1).split('\n').length;
}

/**
 * `key`'s text without the thread's sections, written to `detached`; null when
 * none are its.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} key @param {string} threadId
 * @returns {string | null} */
function detachField(record, detached, key, threadId) {
  const text = record[key];
  const ranges = typeof text === 'string' ? keptRanges(text, threadId) : null;
  if (!(typeof text === 'string' && ranges)) {
    return null;
  }
  const after = joinRanges(text, ranges);
  detached[key] = after;
  return after;
}

/**
 * The active observations and their counters. `bufferedReflectionInputTokens`
 * is Mastra's own slice estimate (doAsyncBufferedReflection): the record's
 * tokens per active line, times the reflected lines.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.ts').ObservationTokenCounter} count */
function detachActive(record, detached, threadId, count) {
  const active = record['activeObservations'];
  const ranges = typeof active === 'string' ? keptRanges(active, threadId) : null;
  if (!(typeof active === 'string' && ranges)) {
    return false;
  }
  const after = joinRanges(active, ranges);
  const tokens = count(after);
  detached['activeObservations'] = after;
  detached['observationTokenCount'] = tokens;
  const lines = record['reflectedObservationLineCount'];
  if (typeof lines !== 'number') {
    return true;
  }
  const reflected = reflectedLinesAfter(active, after, ranges, lines);
  detached['reflectedObservationLineCount'] = reflected;
  if (typeof record['bufferedReflectionInputTokens'] === 'number') {
    detached['bufferedReflectionInputTokens'] = Math.round(
      (tokens / after.split('\n').length) * reflected
    );
  }
  return true;
}

/**
 * The buffered reflection and its tokens. One left empty is cleared with its
 * counters, as Mastra's swapBufferedReflectionToActive clears an activated
 * one, so its lines stay active and unreflected.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.ts').ObservationTokenCounter} count */
function detachReflection(record, detached, threadId, count) {
  const reflection = detachField(record, detached, 'bufferedReflection', threadId);
  if (reflection === null) {
    return false;
  }
  if (reflection !== '') {
    detached['bufferedReflectionTokens'] = count(reflection);
    return true;
  }
  for (const key of [
    'bufferedReflection',
    'bufferedReflectionTokens',
    'bufferedReflectionInputTokens',
    'reflectedObservationLineCount',
  ]) {
    delete detached[key];
  }
  return true;
}

/**
 * The buffered chunks and each changed chunk's tokens.
 * @param {Record<string, unknown>} record @param {Record<string, unknown>} detached
 * @param {string} threadId @param {import('./memory-types.ts').ObservationTokenCounter} count */
function detachChunks(record, detached, threadId, count) {
  const chunks = record['bufferedObservationChunks'];
  if (!Array.isArray(chunks)) {
    return false;
  }
  let changed = false;
  detached['bufferedObservationChunks'] = chunks.flatMap(
    /** @param {Record<string, unknown>} chunk */ (chunk) => {
      const text = chunk['observations'];
      const ranges = typeof text === 'string' ? keptRanges(text, threadId) : null;
      if (!(typeof text === 'string' && ranges)) {
        return [chunk];
      }
      changed = true;
      // A buffered chunk that held only the deleted thread has nothing left to activate.
      if (ranges.length === 0) {
        return [];
      }
      const observations = joinRanges(text, ranges);
      return [{ ...chunk, observations, tokenCount: count(observations) }];
    }
  );
  return changed;
}

/**
 * One shared observation record without `threadId`'s sections, or null when
 * none are its. Each changed text's token field is recounted with Mastra OM's
 * own counter, the one that set it; untouched texts keep their stored counts.
 * @param {Record<string, unknown>} record @param {string} threadId
 * @param {import('./memory-types.ts').ObservationTokenCounter | undefined} countTokens
 * @returns {Record<string, unknown> | null} */
function detachRecord(record, threadId, countTokens) {
  /** @param {string} text */
  const count = (text) => {
    if (!countTokens) {
      throw new Error('Detaching thread observations requires the observation token counter');
    }
    return countTokens(text);
  };
  const detached = { ...record };
  // In order: a reflection left empty clears the line count the active pass set.
  const changed = [
    detachActive(record, detached, threadId, count),
    detachField(record, detached, 'bufferedObservations', threadId) !== null,
    detachReflection(record, detached, threadId, count),
    detachChunks(record, detached, threadId, count),
  ];
  return changed.includes(true) ? detached : null;
}

/**
 * The shared observation records that change when `threadId`'s sections are
 * removed, each with its detached payload.
 * @param {readonly import('./memory-types.ts').MemoryObservationRecord[]} records
 * @param {string} threadId
 * @param {import('./memory-types.ts').ObservationTokenCounter | undefined} countTokens
 * @returns {import('./memory-types.ts').MemoryObservationRecord[]} */
export function detachThreadObservations(records, threadId, countTokens) {
  return records.flatMap((record) => {
    const detached = detachRecord(record.payload, threadId, countTokens);
    return detached
      ? [
          {
            id: record.id,
            payload: /** @type {import('./memory-types.ts').MemoryJsonObject} */ (detached),
          },
        ]
      : [];
  });
}
