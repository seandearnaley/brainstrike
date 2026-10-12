// BST-1939: a deterministic generated corpus committed through the real
// IndexerPort (line policy, text-only), so the native trigram table and its
// triggers are the production ones. Words come from recorded code-search
// patterns; lines mix case, punctuation, tabs and the non-ASCII characters
// that case folding treats specially (U+0130, U+212A, U+017F).
// Usage: node build-grep-corpus.mjs <dbPath> <files> <linesPerFile>
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { openIndexer } from '@brainstrike/indexer';

const [dbPath, fileCount, linesPerFile] = process.argv.slice(2);
const recorded = JSON.parse(
  await readFile(
    createRequire(import.meta.url).resolve(
      '@brainstrike/test-utils/fixtures/recorded-grep-patterns.json'
    ),
    'utf8'
  )
);
const words = [
  ...new Set(recorded.patterns.flatMap(({ pattern }) => pattern.split(/[^A-Za-z0-9_]+/u))),
].filter((word) => word.length > 1);
let state = 1939;
/** mulberry32, so every run builds the same corpus. */
function next() {
  state = (state + 0x6d_2b_79_f5) | 0;
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}
const pick = (values) => values[Math.floor(next() * values.length)];
const joiners = [' ', '.', '(', ')', '::', ' => ', ', ', '\t', '"', "'", '_', '-', ''];
const unusual = ['é', 'İ', 'K', 'ſ', '漢字', '😀', 'ÉLAN', ' '];
function word() {
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
}
function line() {
  const indent = pick(['', '  ', '    ', '\t']);
  const parts = Array.from({ length: 1 + Math.floor(next() * 8) }, word);
  return `${indent}${parts.map((part) => `${part}${pick(joiners)}`).join('')}`;
}
const rootId = 'generated-root';
const port = await openIndexer(
  { dbPath, embedding: { indexMode: 'text-only' }, rootIds: [rootId] },
  { closeMs: 5000, exitMs: 5000, requestMs: 30_000, startupMs: 30_000 }
);
// Lines whose lowercase gains ASCII letters (U+0130 -> i, U+212A -> k) or that
// only a Unicode-aware fold equates; the differential patterns target them.
const edge = [
  'before xa\u0130 after',
  '\u212aelvin scale',
  'MAR\u212aER',
  '\u017ftate machine',
  '\u00c9LAN vital',
  'na\u00efve caf\u00e9',
];
let chunks = 0;
try {
  const edgePlan = await port.prepareFile({
    chunkLines: 1,
    content: `${edge.join('\n')}\n`,
    fileId: 'generated-edge',
    relativePath: 'generated/edge.ts',
    rootId,
  });
  await port.commitTextFile({ plan: edgePlan });
  chunks += edgePlan.chunks.length;
  for (let index = 0; index < Number(fileCount); index += 1) {
    const content = `${Array.from({ length: Number(linesPerFile) }, line).join('\n')}\n`;
    const plan = await port.prepareFile({
      chunkLines: 10,
      content,
      fileId: `generated-${index}`,
      relativePath: `generated/${index % 17}/file-${index}.ts`,
      rootId,
    });
    await port.commitTextFile({ plan });
    chunks += plan.chunks.length;
  }
} finally {
  await port.close();
}
process.stdout.write(`${JSON.stringify({ chunks, rootId })}\n`);
