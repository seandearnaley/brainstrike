// BST-1997: a real IndexerPort index (text-only, so its schema carries the
// production vec_chunks USING vec0 table) for the grep reader's lifecycle and
// sandbox tests. Each root isolates one behaviour:
//   proof-root   two known chunks for exact grep results;
//   runaway-root one 300,000-character line that `\w+\d` scans for tens of
//                seconds (quadratic backtracking), so a deadline, close or crash
//                always lands mid-read;
//   wide-root    210 chunks of ~6 KB that all match `budget`, past the 1 MiB
//                process-message budget at 200 rows.
// Usage: node build-lifecycle-index.mjs <dbPath> [append]
// `append` commits one more proof-root file through the real writer.
import { openIndexer } from '@brainstrike/indexer';

const [dbPath, mode] = process.argv.slice(2);
const rootIds = ['proof-root', 'runaway-root', 'wide-root'];
const port = await openIndexer(
  { dbPath, embedding: { indexMode: 'text-only' }, rootIds },
  { closeMs: 5000, exitMs: 5000, requestMs: 30_000, startupMs: 30_000 }
);
const commit = async (rootId, fileId, relativePath, content) => {
  const plan = await port.prepareFile({ chunkLines: 1, content, fileId, relativePath, rootId });
  await port.commitTextFile({ plan });
  return plan.chunks.map((chunk) => chunk.chunkId);
};
const chunkIds = {};
try {
  if (mode === 'append') {
    chunkIds.afterKill = await commit(
      'proof-root',
      'after-kill',
      'after-kill.ts',
      'writer remains usable\n'
    );
  } else {
    chunkIds.proof = await commit('proof-root', 'proof', 'proof.ts', 'CAFÉ alpha\nalphabet\n');
    chunkIds.runaway = await commit(
      'runaway-root',
      'runaway',
      'runaway.txt',
      `${'a'.repeat(300_000)}\n`
    );
    const wideLine = `budget ${'w'.repeat(6000)}\n`;
    chunkIds.wide = await commit('wide-root', 'wide', 'wide.txt', wideLine.repeat(210));
  }
} finally {
  await port.close();
}
process.stdout.write(`${JSON.stringify({ chunkIds, rootIds })}\n`);
