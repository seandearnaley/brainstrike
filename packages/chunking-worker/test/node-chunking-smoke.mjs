import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createNodeChunker } from '@brainstrike/chunking-worker/node';

const fixture = JSON.parse(
  await readFile(
    new URL('../../indexer/__tests__/fixtures/canonical-provided-chunks.json', import.meta.url),
    'utf8'
  )
);
const chunker = createNodeChunker({ parser: 'oxc' });
const result = await chunker(fixture.content, {
  filePath: fixture.relativePath,
  maxTokens: 256,
  strategy: 'auto',
  tokenTrueSizing: true,
});
for (const field of ['chunks', 'symbols', 'symbolRefs', 'totalTokens', 'skipped', 'strategyUsed']) {
  assert.deepEqual(result[field], fixture.result[field], `Recorded canonical ${field}`);
}
const python = await chunker('def greet(name):\n    return f"hello {name}"\n', {
  fileName: 'greet.py',
  strategy: 'auto',
  tokenTrueSizing: true,
});
assert.equal(python.chunks.length, 1);
assert.equal(python.chunks[0].content, 'def greet(name):\n    return f"hello {name}"');
assert.equal((await chunker('', { fileName: 'empty.txt', strategy: 'auto' })).skipped, true);
assert.equal(globalThis.window, undefined);
assert.equal(globalThis.self, undefined);
// biome-ignore lint/suspicious/noConsole: bounded qualification result from a standalone process.
console.log(
  JSON.stringify({
    canonicalParity: true,
    chunks: result.chunks.length,
    node: process.version,
    parser: 'oxc-native',
    pythonChunks: python.chunks.length,
    refs: result.symbolRefs.length,
    symbols: result.symbols.length,
  })
);
