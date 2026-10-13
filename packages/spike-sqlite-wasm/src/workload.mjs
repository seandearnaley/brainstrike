// @ts-check
// biome-ignore-all lint/style/useNamingConvention: row objects use the desktop SQL column names.
// BST-1940 spike: deterministic workload shared by Node parity and both browser engines.
// The text generator is #3566's build-grep-corpus.mjs (mulberry32, recorded-pattern words, the same
// joiners and case-folding edge characters), so content looks like the code the app indexes.

/** @param {number} seed */
export function rng(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** @param {readonly { pattern: string }[]} patterns @returns {string[]} */
export function wordsOf(patterns) {
  return [...new Set(patterns.flatMap(({ pattern }) => pattern.split(/[^A-Za-z0-9_]+/u)))].filter(
    (word) => word.length > 1
  );
}

const joiners = [' ', '.', '(', ')', '::', ' => ', ', ', '\t', '"', "'", '_', '-', ''];
const unusual = ['é', 'İ', 'K', 'ſ', '漢字', '😀', 'ÉLAN', ' '];

/** @param {() => number} next @param {readonly string[]} words */
function liner(next, words) {
  /** @template T @param {readonly T[]} values @returns {T} */
  const pick = (values) => /** @type {T} */ (values[Math.floor(next() * values.length)]);
  const word = () => {
    const base = pick(words);
    const roll = next();
    if (roll < 0.15) {
      return base.toUpperCase();
    }
    if (roll < 0.25) {
      return base.toLowerCase();
    }
    if (roll < 0.32) {
      return `${pick(unusual)}${base}`;
    }
    return base;
  };
  return () => {
    const indent = pick(['', '  ', '    ', '\t']);
    const parts = Array.from({ length: 1 + Math.floor(next() * 8) }, word);
    return `${indent}${parts.map((part) => `${part}${pick(joiners)}`).join('')}`;
  };
}

/**
 * Chunk rows in the desktop derived-store shape (file_records / file_chunks, line policy).
 * @param {{ seed: number, files: number, chunksPerFile: number, linesPerChunk: number, rootId: string, words: readonly string[], fileOffset?: number }} options
 */
export function chunkFiles({
  chunksPerFile,
  fileOffset = 0,
  files,
  linesPerChunk,
  rootId,
  seed,
  words,
}) {
  const line = liner(rng(seed), words);
  /** @type {{ file: Record<string, unknown>, chunks: Record<string, unknown>[] }[]} */
  const result = [];
  for (let index = fileOffset; index < fileOffset + files; index++) {
    const fileId = `file-${index}`;
    const chunks = [];
    let offset = 0;
    for (let chunk = 0; chunk < chunksPerFile; chunk++) {
      const content = Array.from({ length: linesPerChunk }, line).join('\n');
      const startLine = chunk * linesPerChunk + 1;
      chunks.push({
        chunk_index: chunk,
        chunk_size: content.length,
        chunk_type: 'text',
        content,
        content_hash: `h${index}-${chunk}`,
        end_line: startLine + linesPerChunk - 1,
        end_offset: offset + content.length,
        file_record_id: fileId,
        id: `${fileId}#${chunk}`,
        root_id: rootId,
        start_line: startLine,
        start_offset: offset,
        token_count: Math.max(1, Math.round(content.length / 4)),
      });
      offset += content.length + 1;
    }
    result.push({
      chunks,
      file: {
        content_hash: `c${index}`,
        id: fileId,
        name: `file-${index}.ts`,
        path: `generated/${index % 17}/file-${index}.ts`,
        root_id: rootId,
        snapshot_hash: `s${index}`,
      },
    });
  }
  return result;
}

/**
 * Conversation rows for history search (state_event_rows + state_search_rows shape).
 * @param {{ seed: number, threads: number, perThread: number, words: readonly { pattern: string }[] }} options
 */
export function historyMessages({ perThread, seed, threads, words }) {
  const next = rng(seed);
  const line = liner(next, wordsOf(words));
  const messages = [];
  let pk = 1;
  for (let thread = 0; thread < threads; thread++) {
    for (let seq = 1; seq <= perThread; seq++) {
      const role = seq % 2 === 1 ? 'user' : 'assistant';
      const text = Array.from({ length: role === 'user' ? 2 : 6 }, line).join(' ');
      const runId = `run-${thread}-${Math.ceil(seq / 2)}`;
      messages.push({
        payload: JSON.stringify({
          runId,
          seq,
          text,
          type: role === 'user' ? 'prompt' : 'answer',
          v: 1,
        }),
        pk: pk++,
        role,
        runId,
        seq,
        text,
        threadId: `thread-${thread}`,
      });
    }
  }
  return messages;
}

/**
 * One run's committed rows, in the host's commit pattern (ADR-0011 + amendments): per step a streaming
 * batch (start-step, tool rows, finish-step, model.step) then a boundary. Text deltas are telemetry and
 * not committed. Payload sizes: tool output ~2 KB, model.step ~3 KB.
 * @param {{ seed: number, threadId: string, runId: string, steps: number, startSeq: number, words: readonly string[] }} options
 */
export function runSteps({ runId, seed, startSeq, steps, threadId, words }) {
  const line = liner(rng(seed), words);
  const text = (bytes) => {
    let value = '';
    while (value.length < bytes) {
      value += `${line()}\n`;
    }
    return value.slice(0, bytes);
  };
  let seq = startSeq;
  /** @type {{ seq: number, type: string, body: string }[][]} */
  const batches = [];
  for (let step = 0; step < steps; step++) {
    const toolCallId = `${runId}-call-${step}`;
    batches.push(
      [
        { body: { stepIndex: step }, type: 'start-step' },
        {
          body: { input: { pattern: line() }, toolCallId, toolName: 'grep' },
          type: 'tool-input-available',
        },
        { body: { output: text(2048), toolCallId }, type: 'tool-output-available' },
        {
          body: { finishReason: 'tool-calls', usage: { inputTokens: 1200, outputTokens: 80 } },
          type: 'finish-step',
        },
        { body: { message: { content: text(3072), role: 'assistant' } }, type: 'model.step' },
      ].map(({ body, type }) => ({
        body: JSON.stringify({ runId, threadId, type, ...body }),
        seq: seq++,
        type,
      }))
    );
  }
  return batches;
}
