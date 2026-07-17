/**
 * Vector-search benchmark for PGlite: filtered-recall strategies + (opt-in)
 * binary-quantization two-stage retrieval.
 *
 * Originally the go/no-go harness for two-stage binary quantization
 * (docs/binary-quantization-two-stage-benchmark-2026-07-11.md — verdict NO-GO;
 * those arms are now behind --twoStage). Extended to evaluate fixes for the
 * filtered-search recall collapse that evaluation surfaced (39.5% recall@10 at
 * 100k rows with a ~10% filter on the production path):
 *
 *   A) single-stage: partial halfvec HNSW index, prod query shape
 *      (SET LOCAL hnsw.ef_search=100 + hnsw.iterative_scan='strict_order',
 *      ORDER BY embedding::halfvec(N) <=> $1::halfvec(N), 10x overfetch)
 *   B) exact-filtered: same query shape but full-precision `embedding <=>
 *      $1::vector(N)` — the expression cannot match the halfvec index, so the
 *      planner exact-scans the filtered subset (100% recall by construction)
 *   C) adaptive: bounded selectivity counts route each query to (B) when the
 *      filter is selective (matched <= --exactMaxRows AND matched/total <=
 *      --selRatio) and to (A) otherwise; latency includes the counts
 *   D) mst-sweep: (A) plus SET LOCAL hnsw.max_scan_tuples raised per --mst
 *   E) partial-index: per-filter partial halfvec HNSW index (built AFTER
 *      arms A-D so it cannot contaminate their plans), prod query shape
 *   F) --twoStage only: bit(N) hamming (<~>) prefilter LIMIT P, reranked by
 *      full-precision cosine over the P candidates
 * against exact fp32 cosine ground truth (forced seq scan).
 *
 * Reports recall@k, latency p50/p95, index build time, and index/table sizes.
 *
 * Run from packages/db:
 *   pnpm exec tsx scripts/benchmark-binary-quantization.ts --rows 10000
 *   pnpm exec tsx scripts/benchmark-binary-quantization.ts --rows 100000 --mwm 512MB --json out.json
 *
 * Flags: --rows N (default 10000), --dims D (default 1024), --queries Q (default 40),
 *        --k K (default 10), --seed S (default 42), --json <path>,
 *        --mwm 512MB (maintenance_work_mem for index builds),
 *        --singleEf 100,200 (ef_search sweep; 100 = prod default),
 *        --mst 40000,200000 (hnsw.max_scan_tuples sweep; default 2*rows when
 *          that exceeds pgvector's 20k default, else skipped),
 *        --exactMaxRows N (default 20000), --selRatio R (default 0.15),
 *        --skipPartial (skip arm E),
 *        --twoStage (build the bit index + run arm F),
 *        --rerank P1,P2,... (arm F pools, default 40,100,200,400,800),
 *        --spread / --aniso (corpus geometry)
 *
 * NOT part of any build/CI lane — manual benchmark harness.
 */
import { writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

// ---------- args ----------
function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argNumberList(name: string, fallback: string): number[] {
  return (argValue(name) ?? fallback)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}
const ROWS = Number(argValue('rows') ?? 10_000);
const DIMS = Number(argValue('dims') ?? 1024);
const QUERIES = Number(argValue('queries') ?? 40);
const K = Number(argValue('k') ?? 10);
const SEED = Number(argValue('seed') ?? 42);
const JSON_OUT = argValue('json');
/** maintenance_work_mem for index builds, e.g. --mwm 512MB (default: PGlite's 64MB) */
const MWM = argValue('mwm');
/** ef_search sweep for the single-stage arm (default: prod's 100) */
const SINGLE_EFS = argNumberList('singleEf', '100');
/**
 * hnsw.max_scan_tuples sweep (iterative-scan visit cap; pgvector default 20k).
 * Default: 2*rows when that exceeds the 20k default (i.e. the cap plausibly
 * binds), else skipped.
 */
const MST_VALUES = argNumberList('mst', ROWS * 2 > 20_000 ? String(ROWS * 2) : '');
/** adaptive arm: max matched rows for which an exact scan is affordable */
const EXACT_MAX_ROWS = Number(argValue('exactMaxRows') ?? 20_000);
/** adaptive arm: max matched/total ratio treated as "selective" */
const SEL_RATIO = Number(argValue('selRatio') ?? 0.15);
const SKIP_PARTIAL = argFlag('skipPartial');
const TWO_STAGE = argFlag('twoStage');
const RERANK_POOLS = argNumberList('rerank', '40,100,200,400,800');
/** intra-cluster spread: cosine within cluster ~= 1/sqrt(1+spread^2) */
const SPREAD = Number(argValue('spread') ?? 0.75);
/** anisotropy: unrelated-pair cosine ~= aniso^2 (0.55 -> ~0.3, bge-like) */
const ANISO = Number(argValue('aniso') ?? 0.55);

// Mirrors production constants (packages/db/src/repositories/_shared.ts +
// dimension-index-helpers.ts): ef_search 100, iterative strict_order, m=16, efc=64,
// computeOverfetchLimit(k) = clamp(k*10, 100, 10000).
const PROD_EF_SEARCH = 100;
const HNSW_M = 16;
const HNSW_EFC = 64;
const OVERFETCH = Math.min(Math.max(K * 10, 100), 10_000);

// ---------- deterministic RNG (mulberry32 + Box-Muller) ----------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = mulberry32(SEED);
function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) {
    u = rand();
  }
  while (v === 0) {
    v = rand();
  }
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) {
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) {
    (v as Float32Array)[i] = (v[i] as number) / norm;
  }
  return v;
}
function gaussianVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    v[i] = randn();
  }
  return v;
}
/**
 * point = normalize(center + spread * unitGaussian): intra-cluster cosine
 * ~= 1/sqrt(1+spread^2) (spread 0.75 -> ~0.8, matching related code chunks).
 */
function clusterPoint(center: Float32Array, spread: number): Float32Array {
  const g = normalize(gaussianVec(center.length));
  const v = new Float32Array(center.length);
  for (let i = 0; i < center.length; i++) {
    v[i] = (center[i] as number) + spread * (g[i] as number);
  }
  return normalize(v);
}
/**
 * Mix in a shared mean direction: real embedding spaces (e.g. bge-m3) are
 * anisotropic — unrelated pairs sit at cosine ~aniso^2 (aniso 0.55 -> ~0.3),
 * which degrades sign-based binary quantization and must be modeled.
 */
function applyAnisotropy(v: Float32Array, mean: Float32Array, aniso: number): Float32Array {
  if (aniso === 0) {
    return v;
  }
  const w = Math.sqrt(1 - aniso * aniso);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = w * (v[i] as number) + aniso * (mean[i] as number);
  }
  return normalize(out);
}
function vecText(v: Float32Array): string {
  // 6 significant digits keeps insert payloads manageable; fp32 storage anyway.
  let s = '[';
  for (let i = 0; i < v.length; i++) {
    s += (v[i] as number).toPrecision(6);
    if (i < v.length - 1) {
      s += ',';
    }
  }
  return `${s}]`;
}

// ---------- timing helpers ----------
function now(): number {
  return performance.now();
}
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}
interface LatencyStats {
  mean: number;
  p50: number;
  p95: number;
}
function stats(samples: number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
  return { mean, p50: pct(sorted, 50), p95: pct(sorted, 95) };
}

// ---------- benchmark ----------
interface ArmResult {
  arm: string;
  latency: LatencyStats;
  recallAtK: number;
  /** adaptive arm only: how many queries each route served */
  routes?: Record<string, number>;
  scenario: string;
}

async function main(): Promise<void> {
  console.log(
    `vector-search benchmark: rows=${ROWS} dims=${DIMS} queries=${QUERIES} k=${K} seed=${SEED} ` +
      `singleEf=${SINGLE_EFS.join('/')} mst=${MST_VALUES.join('/') || 'skip'} ` +
      `exactMaxRows=${EXACT_MAX_ROWS} selRatio=${SEL_RATIO} partial=${!SKIP_PARTIAL} ` +
      `twoStage=${TWO_STAGE}${TWO_STAGE ? ` rerankPools=${RERANK_POOLS.join('/')}` : ''}`
  );
  // memory:// — pure WASM, single connection, like the app
  const db = new PGlite({ extensions: { vector } });
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  const ver = await db.query<{ extversion: string }>(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
  );
  const mwm = await db.query<{ maintenance_work_mem: string }>('SHOW maintenance_work_mem');
  console.log(
    `pgvector ${ver.rows[0]?.extversion}, maintenance_work_mem=${mwm.rows[0]?.maintenance_work_mem}`
  );

  // Minimal mirror of file_chunks' vector-relevant shape: dimensionless vector
  // column + a selectivity filter column (embedding_set_id analog).
  await db.query(`
    CREATE TABLE bench_chunks (
      id int PRIMARY KEY,
      set_tag text NOT NULL,
      embedding vector NOT NULL
    )
  `);

  // ----- corpus generation: clustered unit vectors -----
  const numClusters = Math.max(64, Math.round(ROWS / 200));
  console.log(
    `generating ${ROWS} clustered vectors (${numClusters} clusters, spread=${SPREAD}, aniso=${ANISO})...`
  );
  const meanDir = normalize(gaussianVec(DIMS));
  const centers: Float32Array[] = [];
  for (let c = 0; c < numClusters; c++) {
    centers.push(normalize(gaussianVec(DIMS)));
  }

  const tGen0 = now();
  const BATCH = 50;
  let inserted = 0;
  while (inserted < ROWS) {
    const n = Math.min(BATCH, ROWS - inserted);
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const id = inserted + i;
      const center = centers[id % numClusters] as Float32Array;
      const point = applyAnisotropy(clusterPoint(center, SPREAD), meanDir, ANISO);
      // ~10% of rows carry the selective tag (root-scoped search analog)
      const tag = id % 10 === 0 ? 'selective' : 'main';
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::vector(${DIMS}))`);
      params.push(id, tag, vecText(point));
    }
    await db.query(
      `INSERT INTO bench_chunks (id, set_tag, embedding) VALUES ${values.join(',')}`,
      params
    );
    inserted += n;
    if (inserted % 10_000 === 0) {
      console.log(`  inserted ${inserted}/${ROWS} (${((now() - tGen0) / 1000).toFixed(1)}s)`);
    }
  }
  const insertSecs = (now() - tGen0) / 1000;
  console.log(`insert done in ${insertSecs.toFixed(1)}s`);

  // queries: perturbed points from random clusters (never identical to a row)
  const queryVecs: string[] = [];
  for (let q = 0; q < QUERIES; q++) {
    const center = centers[Math.floor(rand() * numClusters)] as Float32Array;
    queryVecs.push(vecText(applyAnisotropy(clusterPoint(center, SPREAD), meanDir, ANISO)));
  }

  // ----- index builds (timed separately) -----
  if (MWM) {
    if (!/^\d+(MB|GB|kB)$/.test(MWM)) {
      throw new Error(`--mwm must look like 512MB, got: ${MWM}`);
    }
    await db.query(`SET maintenance_work_mem = '${MWM}'`);
    console.log(`maintenance_work_mem raised to ${MWM} for index builds`);
  }
  console.log('building halfvec HNSW index (production shape)...');
  const tHv0 = now();
  await db.query(`
    CREATE INDEX idx_bench_hv ON bench_chunks
    USING hnsw ((embedding::halfvec(${DIMS})) halfvec_cosine_ops)
    WITH (m=${HNSW_M}, ef_construction=${HNSW_EFC})
    WHERE vector_dims(embedding) = ${DIMS}
  `);
  const halfvecBuildSecs = (now() - tHv0) / 1000;
  console.log(`  halfvec HNSW built in ${halfvecBuildSecs.toFixed(1)}s`);

  let bitBuildSecs: number | undefined;
  if (TWO_STAGE) {
    console.log('building bit(N) binary-quantized HNSW index...');
    const tBq0 = now();
    await db.query(`
      CREATE INDEX idx_bench_bq ON bench_chunks
      USING hnsw ((binary_quantize(embedding)::bit(${DIMS})) bit_hamming_ops)
      WITH (m=${HNSW_M}, ef_construction=${HNSW_EFC})
      WHERE vector_dims(embedding) = ${DIMS}
    `);
    bitBuildSecs = (now() - tBq0) / 1000;
    console.log(`  bit HNSW built in ${bitBuildSecs.toFixed(1)}s`);
  }

  // pg_total_relation_size for the table: the fp32 vectors are TOASTed, so
  // pg_relation_size on the main fork alone wildly under-reports them.
  const sizes = await db.query<{ name: string; bytes: string }>(`
    SELECT relname AS name,
           CASE WHEN relname = 'bench_chunks'
                THEN pg_total_relation_size(oid) - pg_indexes_size(oid)
                ELSE pg_relation_size(oid) END::text AS bytes
    FROM pg_class WHERE relname IN ('bench_chunks','idx_bench_hv','idx_bench_bq')
  `);
  const sizeMap = new Map(sizes.rows.map((r) => [r.name, Number(r.bytes)]));
  const mb = (b: number | undefined): string => `${((b ?? 0) / 1024 / 1024).toFixed(1)} MB`;
  console.log(
    `sizes: table=${mb(sizeMap.get('bench_chunks'))} halfvecIdx=${mb(sizeMap.get('idx_bench_hv'))}` +
      (TWO_STAGE ? ` bitIdx=${mb(sizeMap.get('idx_bench_bq'))}` : '')
  );

  // ----- query runners -----
  interface TxStatement {
    params?: unknown[];
    sql: string;
  }
  async function runTx(statements: TxStatement[]): Promise<{ rows: { id: number }[] }> {
    await db.query('BEGIN');
    try {
      let result: { rows: { id: number }[] } = { rows: [] };
      for (const st of statements) {
        result = (await db.query(st.sql, st.params)) as { rows: { id: number }[] };
      }
      await db.query('COMMIT');
      return result;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  // Prod always filters embedding_set_id = $X; 'main' matches ~90% of rows
  // (whole-set search), 'selective' ~10% (root-scoped search analog).
  function filterCondition(scenario: string): string {
    return scenario === 'selective' ? `set_tag = 'selective'` : `set_tag = 'main'`;
  }

  // exact fp32 ground truth — forced seq scan
  async function groundTruth(qv: string, scenario: string): Promise<number[]> {
    const res = await runTx([
      { sql: 'SET LOCAL enable_indexscan = off' },
      {
        params: [qv],
        sql: `SELECT id FROM bench_chunks
              WHERE vector_dims(embedding) = ${DIMS} AND ${filterCondition(scenario)}
              ORDER BY embedding <=> $1::vector(${DIMS}) LIMIT ${K}`,
      },
    ]);
    return res.rows.map((r) => r.id);
  }

  // Arm A: production single-stage halfvec (ef_search 100 = prod default).
  // maxScanTuples (arm D) raises pgvector's iterative-scan visit cap (default 20k).
  async function singleStage(
    qv: string,
    scenario: string,
    ef: number,
    maxScanTuples?: number
  ): Promise<number[]> {
    const tuning: TxStatement[] = [
      { sql: `SET LOCAL hnsw.ef_search = ${Math.min(1000, ef)}` },
      { sql: `SET LOCAL hnsw.iterative_scan = 'strict_order'` },
    ];
    if (maxScanTuples !== undefined) {
      tuning.push({ sql: `SET LOCAL hnsw.max_scan_tuples = ${maxScanTuples}` });
    }
    const res = await runTx([
      ...tuning,
      {
        params: [qv],
        sql: `SELECT id FROM bench_chunks
              WHERE vector_dims(embedding) = ${DIMS} AND ${filterCondition(scenario)}
              ORDER BY (embedding::halfvec(${DIMS})) <=> $1::halfvec(${DIMS})
              LIMIT ${OVERFETCH}`,
      },
    ]);
    return res.rows.slice(0, K).map((r) => r.id);
  }

  // Arm B: exact filtered scan, PRODUCTION SHAPE for the proposed fix: the
  // full-precision `embedding <=> $1::vector(N)` expression cannot match the
  // halfvec expression index, so the planner cannot use it — no GUC toggles
  // needed. Same overfetch LIMIT as prod (top-k identical; cost unaffected).
  async function exactFiltered(qv: string, scenario: string): Promise<number[]> {
    const res = (await db.query(
      `SELECT id FROM bench_chunks
       WHERE vector_dims(embedding) = ${DIMS} AND ${filterCondition(scenario)}
       ORDER BY embedding <=> $1::vector(${DIMS})
       LIMIT ${OVERFETCH}`,
      [qv]
    )) as { rows: { id: number }[] };
    return res.rows.slice(0, K).map((r) => r.id);
  }

  // Bounded existence-count: stops scanning once `cap` matching rows are seen.
  // Cheap predicates only (no vector_dims -> no detoast of the vector column).
  async function boundedCount(whereSql: string, cap: number): Promise<number> {
    const res = (await db.query(
      `SELECT COUNT(*)::int AS c FROM (SELECT 1 FROM bench_chunks WHERE ${whereSql} LIMIT ${cap}) t`
    )) as { rows: { c: number }[] };
    return res.rows[0]?.c ?? 0;
  }

  // Arm C: adaptive routing — bounded counts decide exact vs ANN per query.
  // Mirrors the proposed production heuristic:
  //   1. matched = bounded count of the filtered subset (cap exactMaxRows+1).
  //   2. matched > exactMaxRows -> ANN (exact scan unaffordable).
  //   3. else total >= matched/selRatio (bounded count) -> selective -> exact;
  //      otherwise the filter covers most of the set -> ANN keeps its speed.
  async function adaptive(qv: string, scenario: string): Promise<{ ids: number[]; route: string }> {
    const matched = await boundedCount(filterCondition(scenario), EXACT_MAX_ROWS + 1);
    if (matched === 0) {
      return { ids: [], route: 'empty' };
    }
    if (matched <= EXACT_MAX_ROWS) {
      const totalCap = Math.ceil(matched / SEL_RATIO);
      const total = await boundedCount('true', totalCap);
      if (total >= totalCap) {
        return { ids: await exactFiltered(qv, scenario), route: 'exact' };
      }
    }
    return { ids: await singleStage(qv, scenario, PROD_EF_SEARCH), route: 'ann' };
  }

  // Arm F (--twoStage): bit hamming prefilter LIMIT P -> exact cosine rerank
  async function twoStage(qv: string, scenario: string, pool: number): Promise<number[]> {
    const ef = Math.min(1000, Math.max(PROD_EF_SEARCH, pool));
    const res = await runTx([
      { sql: `SET LOCAL hnsw.ef_search = ${ef}` },
      { sql: `SET LOCAL hnsw.iterative_scan = 'strict_order'` },
      {
        params: [qv],
        sql: `SELECT id FROM (
                SELECT id, embedding FROM bench_chunks
                WHERE vector_dims(embedding) = ${DIMS} AND ${filterCondition(scenario)}
                ORDER BY (binary_quantize(embedding)::bit(${DIMS})) <~> binary_quantize($1::vector(${DIMS}))
                LIMIT ${pool}
              ) sub
              ORDER BY sub.embedding <=> $1::vector(${DIMS})
              LIMIT ${OVERFETCH}`,
      },
    ]);
    return res.rows.slice(0, K).map((r) => r.id);
  }

  function recall(got: number[], truth: number[]): number {
    const truthSet = new Set(truth);
    let hit = 0;
    for (const id of got) {
      if (truthSet.has(id)) {
        hit++;
      }
    }
    return truth.length === 0 ? 1 : hit / truth.length;
  }

  async function explainPlan(sql: string, params: unknown[]): Promise<string> {
    const res = (await db.query(`EXPLAIN ${sql}`, params)) as {
      rows: { 'QUERY PLAN': string }[];
    };
    return res.rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  // Measure one arm over all queries against precomputed truths.
  async function measureArm(
    arm: string,
    scenario: string,
    truths: number[][],
    run: (qv: string) => Promise<number[]>
  ): Promise<ArmResult> {
    await run(queryVecs[0] as string); // warmup
    const lat: number[] = [];
    let recallSum = 0;
    for (let i = 0; i < queryVecs.length; i++) {
      const t0 = now();
      const got = await run(queryVecs[i] as string);
      lat.push(now() - t0);
      recallSum += recall(got, truths[i] as number[]);
    }
    const r: ArmResult = {
      arm,
      latency: stats(lat),
      recallAtK: recallSum / queryVecs.length,
      scenario,
    };
    console.log(
      `  ${arm}: recall@${K}=${(r.recallAtK * 100).toFixed(1)}% ` +
        `p50=${r.latency.p50.toFixed(1)}ms p95=${r.latency.p95.toFixed(1)}ms`
    );
    return r;
  }

  const scenarios = ['main', 'selective'];
  const results: ArmResult[] = [];
  const truthsByScenario = new Map<string, number[][]>();

  // Sanity check: the exact-filtered production shape must NOT touch the ANN index.
  {
    const plan = await explainPlan(
      `SELECT id FROM bench_chunks
       WHERE vector_dims(embedding) = ${DIMS} AND set_tag = 'selective'
       ORDER BY embedding <=> $1::vector(${DIMS}) LIMIT ${OVERFETCH}`,
      [queryVecs[0]]
    );
    if (plan.includes('idx_bench_hv')) {
      throw new Error(`exact-filtered plan unexpectedly uses the halfvec index:\n${plan}`);
    }
    console.log(`exact-filtered plan verified index-free (${plan.split('\n')[1]?.trim()})`);
  }

  for (const scenario of scenarios) {
    console.log(`\n=== scenario: ${scenario} ===`);
    // ground truth per query (also serves as seq-scan latency sample)
    const truths: number[][] = [];
    const seqLat: number[] = [];
    for (const qv of queryVecs) {
      const t0 = now();
      truths.push(await groundTruth(qv, scenario));
      seqLat.push(now() - t0);
    }
    truthsByScenario.set(scenario, truths);
    results.push({
      arm: 'exact-seqscan',
      latency: stats(seqLat),
      recallAtK: 1,
      scenario,
    });
    console.log(
      `  exact seq scan: p50=${stats(seqLat).p50.toFixed(1)}ms p95=${stats(seqLat).p95.toFixed(1)}ms`
    );

    // Arm A (ef_search sweep; 100 = production default)
    for (const ef of SINGLE_EFS) {
      results.push(
        await measureArm(`single-stage-halfvec-ef${ef}`, scenario, truths, (qv) =>
          singleStage(qv, scenario, ef)
        )
      );
    }

    // Arm B: exact filtered scan (production shape)
    results.push(
      await measureArm('exact-filtered', scenario, truths, (qv) => exactFiltered(qv, scenario))
    );

    // Arm C: adaptive routing (end-to-end: counts + routed query)
    {
      await adaptive(queryVecs[0] as string, scenario); // warmup
      const lat: number[] = [];
      let recallSum = 0;
      const routes: Record<string, number> = {};
      for (let i = 0; i < queryVecs.length; i++) {
        const t0 = now();
        const { ids, route } = await adaptive(queryVecs[i] as string, scenario);
        lat.push(now() - t0);
        recallSum += recall(ids, truths[i] as number[]);
        routes[route] = (routes[route] ?? 0) + 1;
      }
      const r: ArmResult = {
        arm: 'adaptive',
        latency: stats(lat),
        recallAtK: recallSum / queryVecs.length,
        routes,
        scenario,
      };
      results.push(r);
      console.log(
        `  adaptive: recall@${K}=${(r.recallAtK * 100).toFixed(1)}% ` +
          `p50=${r.latency.p50.toFixed(1)}ms p95=${r.latency.p95.toFixed(1)}ms ` +
          `routes=${JSON.stringify(routes)}`
      );
    }

    // Arm D: max_scan_tuples sweep
    for (const mst of MST_VALUES) {
      results.push(
        await measureArm(`single-stage-mst${mst}`, scenario, truths, (qv) =>
          singleStage(qv, scenario, PROD_EF_SEARCH, mst)
        )
      );
    }

    // Arm F (--twoStage) at each rerank pool size
    if (TWO_STAGE) {
      for (const pool of RERANK_POOLS) {
        results.push(
          await measureArm(`two-stage-bq-P${pool}`, scenario, truths, (qv) =>
            twoStage(qv, scenario, pool)
          )
        );
      }
    }
  }

  // ----- Arm E: partial index per filter value (built LAST so the planner
  // cannot pick it for the arms above) -----
  let partialBuildSecs: number | undefined;
  let partialIndexBytes: number | undefined;
  if (!SKIP_PARTIAL) {
    console.log('\n=== arm: partial-index (selective) ===');
    const tP0 = now();
    await db.query(`
      CREATE INDEX idx_bench_partial_sel ON bench_chunks
      USING hnsw ((embedding::halfvec(${DIMS})) halfvec_cosine_ops)
      WITH (m=${HNSW_M}, ef_construction=${HNSW_EFC})
      WHERE vector_dims(embedding) = ${DIMS} AND set_tag = 'selective'
    `);
    partialBuildSecs = (now() - tP0) / 1000;
    const pSize = await db.query<{ bytes: string }>(
      `SELECT pg_relation_size(oid)::text AS bytes FROM pg_class WHERE relname = 'idx_bench_partial_sel'`
    );
    partialIndexBytes = Number(pSize.rows[0]?.bytes ?? 0);
    console.log(
      `  built in ${partialBuildSecs.toFixed(1)}s, size=${mb(partialIndexBytes)}` +
        ` (rows covered: ~${Math.round(ROWS / 10)})`
    );
    // Verify the planner actually picks the partial index for the selective query.
    const plan = await explainPlan(
      `SELECT id FROM bench_chunks
       WHERE vector_dims(embedding) = ${DIMS} AND set_tag = 'selective'
       ORDER BY (embedding::halfvec(${DIMS})) <=> $1::halfvec(${DIMS}) LIMIT ${OVERFETCH}`,
      [queryVecs[0]]
    );
    const usesPartial = plan.includes('idx_bench_partial_sel');
    console.log(`  plan uses partial index: ${usesPartial}`);
    if (usesPartial) {
      const truths = truthsByScenario.get('selective') as number[][];
      results.push(
        await measureArm('partial-index', 'selective', truths, (qv) =>
          singleStage(qv, 'selective', PROD_EF_SEARCH)
        )
      );
    } else {
      console.log(`  SKIPPING measurements — plan:\n${plan}`);
    }
    await db.query('DROP INDEX idx_bench_partial_sel');
  }

  const report = {
    config: {
      aniso: ANISO,
      dims: DIMS,
      exactMaxRows: EXACT_MAX_ROWS,
      hnsw: { efConstruction: HNSW_EFC, efSearch: PROD_EF_SEARCH, m: HNSW_M },
      k: K,
      mstValues: MST_VALUES,
      numClusters,
      overfetch: OVERFETCH,
      pgvector: ver.rows[0]?.extversion,
      queries: QUERIES,
      rerankPools: TWO_STAGE ? RERANK_POOLS : [],
      rows: ROWS,
      seed: SEED,
      selRatio: SEL_RATIO,
      spread: SPREAD,
      twoStage: TWO_STAGE,
    },
    indexes: {
      ...(bitBuildSecs !== undefined && {
        bitBuildSecs,
        bitIndexBytes: sizeMap.get('idx_bench_bq') ?? 0,
      }),
      halfvecBuildSecs,
      halfvecIndexBytes: sizeMap.get('idx_bench_hv') ?? 0,
      insertSecs,
      ...(partialBuildSecs !== undefined && { partialBuildSecs, partialIndexBytes }),
      tableBytes: sizeMap.get('bench_chunks') ?? 0,
    },
    results,
  };
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${JSON_OUT}`);
  }
  console.log('\nDONE');
  await db.close();
}

await main();
