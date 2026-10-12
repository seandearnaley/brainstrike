/**
 * BST-1939 Phase 0: the in-repo repository retrieval runner.
 *
 *   pnpm exec node apps/desktop/qualification/retrieval/run-retrieval-eval.ts \
 *     --evidence <recorded BST-1922 directory> --out <summary.json>
 *
 * It reads the recorded canonical chunks, source snapshots and vectors (hashes
 * pinned in evidence-manifest.json), builds a fresh native index through the
 * public IndexerPort, and runs the frozen fixture through the existing
 * evaluation harness: precision, recall and MRR per arm, and the
 * vector-retention gate (hybrid must gain 0.05 recall@10 or MRR, losing
 * neither). No model loads and nothing leaves the machine.
 *
 * Control: the 2026-10-03 grep policy. Its metrics, gate and all 400 candidate
 * pools must equal the recorded measurement, or the run fails.
 * Production: the same arms with the native killable reader's grep.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type RepositoryEvaluationReport,
  repositoryRetrievalFixtureSchema,
  runRepositoryRetrievalEvaluation,
} from '@brainstrike/agent';
import {
  buildNativeCorpus,
  type GrepSource,
  nativeReaderGrep,
  openArms,
  recordedPolicyGrep,
} from './arms.ts';
import { compareControl, compareRecordedGrep } from './compare.ts';
import { loadEvidence } from './evidence.ts';

const here = import.meta.dirname;
const FIXTURE = join(
  here,
  '../../../../packages/agent/src/evaluation/fixtures/repository-retrieval.json'
);

const { values } = parseArgs({
  options: { evidence: { type: 'string' }, out: { type: 'string' } },
  strict: true,
});
if (!(values.evidence && values.out)) {
  throw new Error(
    'Usage: run-retrieval-eval.ts --evidence <recorded directory> --out <summary.json>'
  );
}
const evidenceDirectory = values.evidence;
const fixtureText = await readFile(FIXTURE, 'utf8');
const evidence = await loadEvidence(
  evidenceDirectory,
  join(here, 'evidence-manifest.json'),
  fixtureText
);
const fixture = repositoryRetrievalFixtureSchema.parse(JSON.parse(fixtureText));
const queryIds = new Map(fixture.queries.map(({ id, query }) => [query, id]));
const electron: unknown = createRequire(join(here, '../../package.json'))('electron');
if (typeof electron !== 'string') {
  throw new TypeError('The native reader requires the desktop Electron executable.');
}

const summarize = (report: RepositoryEvaluationReport) => ({
  gate: report.gate,
  modes: Object.fromEntries(
    Object.entries(report.modes).map(([mode, metrics]) => [
      mode,
      {
        meanMrr: metrics.meanMrr,
        meanPrecisionAtK: metrics.meanPrecisionAtK,
        meanRecallAtK: metrics.meanRecallAtK,
        successfulEvaluations: metrics.successfulEvaluations,
      },
    ])
  ),
});

const directory = await mkdtemp(join(tmpdir(), 'bs-retrieval-eval-'));
const startedAt = new Date().toISOString();
try {
  const corpus = await buildNativeCorpus(evidence, directory);
  try {
    if (corpus.profileHash !== evidence.original.profileHash) {
      throw new Error('The native profile identity differs from the recorded measurement.');
    }
    const grepPools = {
      'native-reader': await nativeReaderGrep({
        corpus,
        directory,
        electronExecutable: electron,
        queries: fixture.queries.map(({ query }) => query),
        rootId: evidence.rootId,
      }),
      'recorded-policy': { kind: 'recorded-policy' },
    } as const;
    const reports = {} as Record<GrepSource, RepositoryEvaluationReport>;
    for (const grep of ['recorded-policy', 'native-reader'] as const) {
      reports[grep] = await runRepositoryRetrievalEvaluation(fixture, {
        chunking: {
          kind: 'canonical-host',
          producerSourceCommit: evidence.settings.producerSourceCommit,
          ...evidence.settings.options,
        },
        corpusSources: [...evidence.corpusSources],
        profile: evidence.settings.profile,
        profileHash: corpus.profileHash,
        readSource: (path) => readFileSync(join(evidenceDirectory, 'sources', path), 'utf8'),
        search: openArms({ corpus, evidence, grep: grepPools[grep], queryIds }),
      });
    }
    const fixtureQueries = new Map(fixture.queries.map(({ id, query }) => [id, query]));
    const grepDrift = compareRecordedGrep(evidence.grepPools, (queryId) => {
      const { candidates } = recordedPolicyGrep(
        evidence,
        corpus.chunkIds,
        fixtureQueries.get(queryId) ?? '',
        100
      );
      return {
        candidateCount: candidates.length,
        producerIds: candidates
          .slice(0, 100)
          .map((key) => evidence.vectors.producerIds.get(key) ?? key),
      };
    });
    const control = compareControl(reports['recorded-policy'], evidence.original);
    const summary = {
      control: {
        ...summarize(reports['recorded-policy']),
        comparison: control,
        grepPolicyDrift: grepDrift,
        reproduced: control.reproduced && grepDrift.length === 0,
      },
      evidence: { manifest: 'evidence-manifest.json', recorded: evidence.original.profileHash },
      production: summarize(reports['native-reader']),
      run: { node: process.version, startedAt },
    };
    await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`);
    const row = (mode: string) => {
      const before = evidence.original.modes[mode];
      const after =
        reports['recorded-policy'].modes[mode as keyof RepositoryEvaluationReport['modes']];
      const current =
        reports['native-reader'].modes[mode as keyof RepositoryEvaluationReport['modes']];
      return `${mode.padEnd(8)} original R@10 ${before?.meanRecallAtK['10']} MRR ${before?.meanMrr} | control R@10 ${after.meanRecallAtK[10]} MRR ${after.meanMrr} | production R@10 ${current.meanRecallAtK[10]} MRR ${current.meanMrr}`;
    };
    process.stdout.write(
      `${['bm25', 'grep', 'trigram', 'vector', 'lexical', 'hybrid'].map(row).join('\n')}\n` +
        `gate original ${JSON.stringify(evidence.original.gate)}\n` +
        `gate control ${JSON.stringify(reports['recorded-policy'].gate)}\n` +
        `gate production ${JSON.stringify(reports['native-reader'].gate)}\n` +
        `control reproduced: ${summary.control.reproduced} (${control.differences.length} metric differences, ${control.pools.differing.length}/${control.pools.compared} pools differ, ${grepDrift.length} grep policy drifts)\n`
    );
    if (!summary.control.reproduced) {
      process.exitCode = 1;
    }
  } finally {
    await corpus.port.close();
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
