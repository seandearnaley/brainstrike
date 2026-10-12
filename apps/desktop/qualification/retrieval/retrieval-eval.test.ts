import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { recordedPolicyGrep } from './arms.ts';
import { compareControl } from './compare.ts';
import { canonicalFileSchema, verifyEvidence } from './evidence.ts';
import grep from './fixtures/recorded-grep-excerpt.json' with { type: 'json' };
import report from './fixtures/recorded-report-excerpt.json' with { type: 'json' };

test('refuses recorded evidence whose bytes differ from the pinned manifest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bs-retrieval-evidence-'));
  try {
    // A recorded artifact under its own pinned hash, as evidence-manifest.json pins them.
    const recorded = await readFile(
      join(import.meta.dirname, 'fixtures/recorded-report-excerpt.json')
    );
    await writeFile(join(directory, 'retrieval-report.json'), recorded);
    const manifest = join(directory, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        evidence: 'test',
        files: {
          'retrieval-report.json': createHash('sha256').update(recorded).digest('hex'),
        },
        rootId: 'root',
      })
    );
    await verifyEvidence(directory, manifest);
    await appendFile(join(directory, 'retrieval-report.json'), ' ');
    await assert.rejects(
      verifyEvidence(directory, manifest),
      /Recorded evidence retrieval-report\.json changed/u
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('the control passes only on identical metrics, gate and candidate pools', () => {
  const identical = compareControl(report, report);
  assert.equal(identical.reproduced, true);
  assert.equal(identical.pools.compared, 8);
  const metric = structuredClone(report);
  metric.modes.hybrid.meanMrr += 0.001;
  assert.deepEqual(
    compareControl(metric, report).differences.map(({ metric: name, mode }) => `${mode}:${name}`),
    ['hybrid:meanMrr']
  );
  const pool = structuredClone(report);
  const hits = pool.queries[0]?.pools.vector.hits ?? [];
  [hits[0], hits[1]] = [hits[1] ?? { chunkId: '' }, hits[0] ?? { chunkId: '' }];
  const reordered = compareControl(pool, report);
  assert.equal(reordered.reproduced, false);
  assert.deepEqual(reordered.pools.differing, [{ arm: 'vector', queryId: 'repo-001' }]);
  const gate = structuredClone(report);
  gate.gate.passed = true;
  assert.equal(compareControl(gate, report).reproduced, false);
});

test('the recorded grep policy reproduces its recorded pool order', () => {
  const files = z.array(canonicalFileSchema).parse(grep.files);
  const producerIds = new Map(Object.entries(grep.producerIds));
  const recorded = grep.result.hits.map(({ producerChunkId }) => producerChunkId);
  const all = recordedPolicyGrep({ files }, producerIds, grep.result.query, 100);
  assert.equal(all.candidates.length, grep.result.candidateCount);
  assert.deepEqual(
    all.hits.map(({ chunkId }) => chunkId),
    recorded
  );
  const capped = recordedPolicyGrep({ files }, producerIds, grep.result.query, 2);
  assert.deepEqual(
    capped.hits.map(({ chunkId }) => chunkId),
    recorded.slice(0, 2)
  );
  assert.throws(
    () => recordedPolicyGrep({ files }, new Map(), grep.result.query, 100),
    /No native chunk/u
  );
});
