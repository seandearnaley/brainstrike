/**
 * BST-1939 Phase 0: the control's comparison with the recorded 2026-10-03
 * measurement. Metrics must be identical, mode by mode, and every candidate
 * pool must name the same native chunks in the same order.
 */
import type { RetrievalArm } from '@brainstrike/agent';
import type { RecordedGrepPools } from './evidence.ts';

const ARMS: readonly RetrievalArm[] = ['bm25', 'grep', 'trigram', 'vector'];
const CUTOFFS = [1, 3, 5, 10] as const;

interface Gate {
  readonly mrrDelta: number;
  readonly passed: boolean;
  readonly recallDelta: number;
}
interface ModeMetrics {
  readonly meanMrr: number;
  readonly meanPrecisionAtK: Readonly<Record<number, number>>;
  readonly meanRecallAtK: Readonly<Record<number, number>>;
  readonly successfulEvaluations: number;
}
/** What both the harness report and the recorded report carry. */
export interface ComparableReport {
  readonly gate: Gate;
  readonly modes: Readonly<Record<string, ModeMetrics>>;
  readonly queries: readonly {
    readonly id: string;
    readonly pools: Readonly<
      Record<RetrievalArm, { readonly hits: readonly { readonly chunkId: string }[] }>
    >;
  }[];
}

export interface MetricDifference {
  readonly metric: string;
  readonly mode: string;
  readonly original: number | undefined;
  readonly reproduced: number | undefined;
}

export interface ControlComparison {
  readonly differences: readonly MetricDifference[];
  readonly gate: { readonly original: Gate; readonly reproduced: Gate };
  readonly pools: {
    readonly compared: number;
    readonly differing: readonly { readonly arm: RetrievalArm; readonly queryId: string }[];
  };
  readonly reproduced: boolean;
}

function metricValues(metrics: ModeMetrics | undefined): [string, number | undefined][] {
  return [
    ['meanMrr', metrics?.meanMrr],
    ['successfulEvaluations', metrics?.successfulEvaluations],
    ...CUTOFFS.flatMap((k): [string, number | undefined][] => [
      [`recall@${k}`, metrics?.meanRecallAtK[k]],
      [`precision@${k}`, metrics?.meanPrecisionAtK[k]],
    ]),
  ];
}

export function compareControl(
  reproduced: ComparableReport,
  original: ComparableReport
): ControlComparison {
  const differences: MetricDifference[] = [];
  for (const mode of Object.keys(original.modes)) {
    const after = metricValues(reproduced.modes[mode]);
    for (const [index, [metric, value]] of metricValues(original.modes[mode]).entries()) {
      const actual = after[index]?.[1];
      if (actual !== value) {
        differences.push({ metric, mode, original: value, reproduced: actual });
      }
    }
  }
  const pools = new Map(reproduced.queries.map((query) => [query.id, query.pools]));
  const ids = (pool: { readonly hits: readonly { readonly chunkId: string }[] } | undefined) =>
    JSON.stringify(pool?.hits.map(({ chunkId }) => chunkId) ?? null);
  const differing: { arm: RetrievalArm; queryId: string }[] = [];
  for (const query of original.queries) {
    for (const arm of ARMS) {
      if (ids(pools.get(query.id)?.[arm]) !== ids(query.pools[arm])) {
        differing.push({ arm, queryId: query.id });
      }
    }
  }
  const gate = { original: original.gate, reproduced: reproduced.gate };
  return {
    differences,
    gate,
    pools: { compared: original.queries.length * ARMS.length, differing },
    reproduced:
      differences.length === 0 &&
      differing.length === 0 &&
      gate.original.mrrDelta === gate.reproduced.mrrDelta &&
      gate.original.passed === gate.reproduced.passed &&
      gate.original.recallDelta === gate.reproduced.recallDelta,
  };
}

/** Query IDs whose recomputed policy pool differs from recorded grep-pools.json. */
export function compareRecordedGrep(
  recorded: RecordedGrepPools,
  recompute: (queryId: string) => {
    readonly candidateCount: number;
    readonly producerIds: readonly string[];
  }
): readonly string[] {
  return recorded.results.flatMap((result) => {
    const actual = recompute(result.queryId);
    return actual.candidateCount === result.candidateCount &&
      JSON.stringify(actual.producerIds) ===
        JSON.stringify(result.hits.map(({ producerChunkId }) => producerChunkId))
      ? []
      : [result.queryId];
  });
}
