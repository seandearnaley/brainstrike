/**
 * BST-1939 Phase 0: the in-repo repository retrieval runner.
 *
 *   pnpm exec node apps/desktop/qualification/retrieval/run-retrieval-eval.ts \
 *     --evidence <recorded BST-1922 directory> --out <summary.json> \
 *     [--candidate <produced vector directory> --candidate-manifest <pinned hashes>]
 *
 * It reads the recorded canonical chunks, source snapshots and vectors (hashes
 * pinned in evidence-manifest.json), builds a fresh native index through the
 * public IndexerPort, and runs the recorded frozen fixture through the existing
 * evaluation harness: precision, recall and MRR per arm, and the
 * vector-retention gate (hybrid must gain 0.05 recall@10 or MRR, losing
 * neither). No model loads and nothing leaves the machine.
 *
 * Control: the 2026-10-03 grep policy. Its metrics, gate and all 400 candidate
 * pools must equal the recorded measurement, or the run fails.
 * Production: the same arms with the native killable reader's grep.
 * Candidate (Phase 3): the control's arms over a second index holding another
 * profile's vectors (produce-hidden-host-vectors.ts), compared mode by mode.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  type GrepPools,
  type NativeCorpus,
  nativeReaderGrep,
  openArms,
  recordedPolicyGrep,
} from './arms.ts';
import { compareControl, compareRecordedGrep } from './compare.ts';
import { type EmbeddingProfile, loadCandidate, loadEvidence } from './evidence.ts';

const here = import.meta.dirname;

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    'candidate-manifest': { type: 'string' },
    evidence: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});
if (
  !(values.evidence && values.out) ||
  Boolean(values.candidate) !== Boolean(values['candidate-manifest'])
) {
  throw new Error(
    'Usage: run-retrieval-eval.ts --evidence <recorded directory> --out <summary.json> [--candidate <dir> --candidate-manifest <json>]'
  );
}
const evidenceDirectory = values.evidence;
const evidence = await loadEvidence(evidenceDirectory, join(here, 'evidence-manifest.json'));
const candidate =
  values.candidate && values['candidate-manifest']
    ? await loadCandidate(values.candidate, values['candidate-manifest'])
    : undefined;
const fixture = repositoryRetrievalFixtureSchema.parse(evidence.fixture);
const queryIds = new Map(fixture.queries.map(({ id, query }) => [query, id]));
const electron: unknown = createRequire(join(here, '../../package.json'))('electron');
if (typeof electron !== 'string') {
  throw new TypeError('The native reader requires the desktop Electron executable.');
}

type Mode = keyof RepositoryEvaluationReport['modes'];
const MODES: readonly Mode[] = ['bm25', 'grep', 'trigram', 'vector', 'lexical', 'hybrid'];

function summarize(report: RepositoryEvaluationReport) {
  return {
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
  };
}

function evaluate(
  corpus: NativeCorpus,
  profile: EmbeddingProfile,
  grep: GrepPools
): Promise<RepositoryEvaluationReport> {
  return runRepositoryRetrievalEvaluation(fixture, {
    chunking: {
      kind: 'canonical-host',
      producerSourceCommit: evidence.settings.producerSourceCommit,
      ...evidence.settings.options,
    },
    corpusSources: [...evidence.corpusSources],
    profile,
    profileHash: corpus.profileHash,
    readSource: (path) => readFileSync(join(evidenceDirectory, 'sources', path), 'utf8'),
    search: openArms({ corpus, evidence, grep, queryIds }),
  });
}

/** Candidate minus control for recall@10, MRR and precision@k, per mode. */
function abTable(control: RepositoryEvaluationReport, other: RepositoryEvaluationReport) {
  const pick = (report: RepositoryEvaluationReport, mode: Mode) => ({
    mrr: report.modes[mode].meanMrr,
    precision: report.modes[mode].meanPrecisionAtK,
    recallAt10: report.modes[mode].meanRecallAtK[10],
  });
  return Object.fromEntries(
    MODES.map((mode) => {
      const before = pick(control, mode);
      const after = pick(other, mode);
      return [
        mode,
        {
          candidate: after,
          control: before,
          delta: {
            mrr: after.mrr - before.mrr,
            precision: Object.fromEntries(
              Object.entries(after.precision).map(([k, value]) => [
                k,
                value - (before.precision[Number(k)] ?? 0),
              ])
            ),
            recallAt10: (after.recallAt10 ?? 0) - (before.recallAt10 ?? 0),
          },
        },
      ];
    })
  );
}

const directory = await mkdtemp(join(tmpdir(), 'bs-retrieval-eval-'));
const startedAt = new Date().toISOString();
const recordedPolicy: GrepPools = { kind: 'recorded-policy' };
try {
  const corpus = await buildNativeCorpus(
    evidence,
    evidence.vectors,
    evidence.settings.profile,
    directory
  );
  try {
    if (corpus.profileHash !== evidence.original.profileHash) {
      throw new Error('The native profile identity differs from the recorded measurement.');
    }
    const controlReport = await evaluate(corpus, evidence.settings.profile, recordedPolicy);
    const productionReport = await evaluate(
      corpus,
      evidence.settings.profile,
      await nativeReaderGrep({
        corpus,
        directory,
        electronExecutable: electron,
        queries: fixture.queries.map(({ query }) => query),
        rootId: evidence.rootId,
      })
    );
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
    const control = compareControl(controlReport, evidence.original);
    let candidateReport: RepositoryEvaluationReport | undefined;
    if (candidate) {
      const candidateDirectory = join(directory, 'candidate');
      await mkdir(candidateDirectory);
      const candidateCorpus = await buildNativeCorpus(
        evidence,
        candidate.vectors,
        candidate.profile,
        candidateDirectory
      );
      try {
        candidateReport = await evaluate(candidateCorpus, candidate.profile, recordedPolicy);
      } finally {
        await candidateCorpus.port.close();
      }
    }
    const summary = {
      ...(candidate && candidateReport
        ? {
            candidate: {
              ...summarize(candidateReport),
              ab: abTable(controlReport, candidateReport),
              profile: candidate.profile,
            },
          }
        : {}),
      control: {
        ...summarize(controlReport),
        comparison: control,
        grepPolicyDrift: grepDrift,
        reproduced: control.reproduced && grepDrift.length === 0,
      },
      evidence: { manifest: 'evidence-manifest.json', recorded: evidence.original.profileHash },
      production: summarize(productionReport),
      run: { node: process.version, startedAt },
    };
    await writeFile(values.out, `${JSON.stringify(summary, null, 2)}\n`);
    const row = (mode: Mode) => {
      const before = evidence.original.modes[mode];
      const after = controlReport.modes[mode];
      const current = productionReport.modes[mode];
      const other = candidateReport?.modes[mode];
      return `${mode.padEnd(8)} original R@10 ${before?.meanRecallAtK['10']} MRR ${before?.meanMrr} | control R@10 ${after.meanRecallAtK[10]} MRR ${after.meanMrr} | production R@10 ${current.meanRecallAtK[10]} MRR ${current.meanMrr}${other ? ` | candidate R@10 ${other.meanRecallAtK[10]} MRR ${other.meanMrr}` : ''}`;
    };
    process.stdout.write(
      `${MODES.map(row).join('\n')}\n` +
        `gate original ${JSON.stringify(evidence.original.gate)}\n` +
        `gate control ${JSON.stringify(controlReport.gate)}\n` +
        `gate production ${JSON.stringify(productionReport.gate)}\n` +
        (candidateReport ? `gate candidate ${JSON.stringify(candidateReport.gate)}\n` : '') +
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
