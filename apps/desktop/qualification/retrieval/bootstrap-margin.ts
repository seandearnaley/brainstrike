/**
 * BST-1939: paired bootstrap 95% intervals for the retention gate's deltas,
 * hybrid minus lexical, over the frozen queries, for every arm in a runner
 * summary (control and candidates). Computation only: it reads the per-query
 * recall@10 and reciprocal rank the runner recorded.
 *
 *   pnpm exec node apps/desktop/qualification/retrieval/bootstrap-margin.ts \
 *     --summary <runner summary.json> [--resamples 10000] [--seed 1939] [--out <json>]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';

/** The gate's recall bar: hybrid must gain at least this much recall@10 (or MRR). */
const RECALL_BAR = 0.05;

/** mulberry32: a small fixed-seed generator, so every run resamples identically. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export interface Interval {
  readonly high: number;
  readonly low: number;
  readonly mean: number;
}

/** Percentile 95% interval of the mean paired difference, resampling queries with replacement. */
export function pairedBootstrap(
  differences: readonly number[],
  resamples: number,
  seed: number
): Interval {
  const count = differences.length;
  if (count === 0 || !Number.isInteger(resamples) || resamples < 1000) {
    throw new Error('A paired bootstrap needs differences and at least 1,000 resamples.');
  }
  const next = generator(seed);
  const means = new Float64Array(resamples);
  for (let resample = 0; resample < resamples; resample += 1) {
    let sum = 0;
    for (let draw = 0; draw < count; draw += 1) {
      sum += differences[Math.floor(next() * count)] ?? 0;
    }
    means[resample] = sum / count;
  }
  means.sort();
  return {
    high: means[Math.ceil(0.975 * resamples) - 1] ?? Number.NaN,
    low: means[Math.floor(0.025 * resamples)] ?? Number.NaN,
    mean: differences.reduce((sum, value) => sum + value, 0) / count,
  };
}

const metrics = z.object({ mrr: z.array(z.number()), recallAt10: z.array(z.number()) });
const perQuery = z.object({ hybrid: metrics, lexical: metrics, queryIds: z.array(z.string()) });
const summarySchema = z.object({
  candidates: z.record(z.string(), z.object({ perQuery })),
  control: z.object({ perQuery }),
});

/** Each arm's hybrid-minus-lexical intervals, and whether they exclude 0 or clear the bar. */
export function marginReport(
  arms: Readonly<Record<string, z.infer<typeof perQuery>>>,
  resamples: number,
  seed: number
) {
  const queryIds = Object.values(arms)[0]?.queryIds ?? [];
  return Object.fromEntries(
    Object.entries(arms).map(([name, rows]) => {
      if (JSON.stringify(rows.queryIds) !== JSON.stringify(queryIds)) {
        throw new Error(`${name} pairs different queries`);
      }
      const delta = (metric: 'mrr' | 'recallAt10') =>
        rows.hybrid[metric].map((value, index) => value - (rows.lexical[metric][index] ?? 0));
      const recall = pairedBootstrap(delta('recallAt10'), resamples, seed);
      const mrr = pairedBootstrap(delta('mrr'), resamples, seed);
      return [
        name,
        {
          mrr: { ...mrr, excludesZero: mrr.low > 0 || mrr.high < 0 },
          recallAt10: {
            ...recall,
            clearsBarAtLowerBound: recall.low >= RECALL_BAR,
            excludesZero: recall.low > 0 || recall.high < 0,
            meanClearsBar: recall.mean + Number.EPSILON >= RECALL_BAR,
          },
        },
      ];
    })
  );
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      resamples: { default: '10000', type: 'string' },
      seed: { default: '1939', type: 'string' },
      summary: { type: 'string' },
    },
    strict: true,
  });
  if (!values.summary) {
    throw new Error('Usage: bootstrap-margin.ts --summary <runner summary.json>');
  }
  const summary = summarySchema.parse(JSON.parse(await readFile(values.summary, 'utf8')));
  const resamples = Number(values.resamples);
  const seed = Number(values.seed);
  const report = {
    arms: marginReport(
      {
        control: summary.control.perQuery,
        ...Object.fromEntries(
          Object.entries(summary.candidates).map(([name, arm]) => [name, arm.perQuery])
        ),
      },
      resamples,
      seed
    ),
    queries: summary.control.perQuery.queryIds.length,
    resamples,
    seed,
  };
  if (values.out) {
    await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
