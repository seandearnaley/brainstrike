import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = await readFile(
  new URL('../../.github/workflows/nightly-coverage.yml', import.meta.url),
  'utf8'
);

test('nightly package coverage uses six bounded static shards', () => {
  assert.match(workflow, /^ {2}package-coverage:\n/m);
  assert.match(workflow, /fail-fast: false/);

  for (const shard of [
    'agent',
    'app-shell',
    'desktop',
    'embeddings-preferences',
    'ui-db-explorer',
    'remaining',
  ]) {
    assert.match(workflow, new RegExp(`shard: ${shard}`));
  }

  assert.doesNotMatch(workflow, /- name: Run package coverage/);
  assert.match(
    workflow,
    /pnpm turbo run test:coverage[\s\S]*\$\{\{ matrix\.filters \}\}[\s\S]*--concurrency=\$\{\{ matrix\.concurrency \}\}/
  );
  assert.match(
    workflow,
    /shard: remaining[\s\S]*--filter=!@brainstrike\/db[\s\S]*--filter=!@brainstrike\/agent[\s\S]*--filter=!@brainstrike\/db-explorer/
  );
});

test('nightly coverage isolates DB work and fans artifacts into one threshold gate', () => {
  assert.match(workflow, /^ {2}db-coverage:\n/m);
  assert.match(workflow, /^ {2}coverage:\n/m);
  assert.match(workflow, /needs:\n {6}- package-coverage\n {6}- db-coverage/);
  assert.match(workflow, /uses: actions\/download-artifact@v7/);
  assert.match(workflow, /pattern: nightly-coverage-\*/);
  assert.match(workflow, /if \[ "\$archive_count" -ne 7 \]/);
  assert.match(workflow, /run: pnpm coverage:enforce/);
  assert.match(workflow, /name: Notify nightly coverage failure[\s\S]*needs:[\s\S]*- coverage/);
});
