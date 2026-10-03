// Guard for the `unit-shard` matrix partition in .github/workflows/test.yml.
//
// The Unit job partitions packages into db / agent / desktop / heavy / rest.
// DB, Agent, and desktop each use complete native Vitest shard sets; repeated physical
// rows own the same logical package, never slices of different packages.
// The shard id is a task environment input, not a Turbo passthrough argument:
// passthrough arguments also reach dependency and topo tasks.
// The turbo `--filter`s must form an exact partition of the affected set:
//   - db + desktop + heavy list packages POSITIVELY (`--filter=@brainstrike/x`)
//   - rest negates every package the other shards own
// PR invocations intersect these package filters with native `--affected`.
//
// The dangerous drift is silent: if a package is negated out of `rest` but
// never given a positive shard (or a positive package is dropped without
// removing its `rest` negation), it stops being tested entirely — and the
// fan-in `Unit` check still passes because each shard no-ops cleanly. This
// parses the matrix and asserts the partition holds, converting a comment-only
// invariant into a checked contract.

import { parse as parseYaml } from 'yaml';

const PKG = /@brainstrike\/([a-z0-9-]+)/;

/**
 * Extracts the full Unit matrix passed to affected selection and returns, per shard, the
 * positive and negation @brainstrike package-name sets for both pr and push
 * filter modes.
 * @param {string} yamlText full contents of test.yml
 * @returns {{ shard: string, partition: string, vitestShard: {index: number, count: number} | null, pr: {positives: string[], negations: string[]}, push: {positives: string[], negations: string[]} }[]}
 */
export function parseUnitShardMatrix(yamlText) {
  const workflow = parseYaml(yamlText);
  const selection = workflow.jobs.static.steps.find((step) => step.id === 'unit-shards');
  const matrix = JSON.parse(selection.env.UNIT_MATRIX);
  if (!Array.isArray(matrix.include) || matrix.include.length === 0) {
    throw new Error('no Unit matrix rows found in workflow');
  }
  return matrix.include.map((row) => {
    const shard = row.shard;
    const partition = row.partition;
    if (typeof partition !== 'string' || !partition) {
      throw new Error(`unit-shard matrix row "${shard}" has no explicit partition`);
    }
    const rawVitestShard = row.vitest_shard;
    if (typeof rawVitestShard !== 'string') {
      throw new Error(`unit-shard matrix row "${shard}" has no explicit vitest_shard`);
    }
    const vitestShard = rawVitestShard;
    const shardMatch = /^(\d+)\/(\d+)$/u.exec(vitestShard);
    if (vitestShard !== '' && !shardMatch) {
      throw new Error(
        `unit-shard matrix row "${shard}" has malformed vitest_shard "${vitestShard}"; ` +
          'expected empty or exactly "i/N"'
      );
    }
    const prBlock = row.pr_filters;
    const pushBlock = row.push_filters;
    return {
      partition,
      pr: classifyFilters(prBlock),
      push: classifyFilters(pushBlock),
      shard,
      vitestShard: shardMatch
        ? { count: Number(shardMatch[2]), index: Number(shardMatch[1]) }
        : null,
    };
  });
}

function classifyFilters(text) {
  const positives = new Set();
  const negations = new Set();
  // Match each `--filter=...` / `--filter="..."` token.
  for (const match of text.matchAll(/--filter=(?:"([^"]*)"|(\S+))/g)) {
    const value = match[1] ?? match[2] ?? '';
    const pkg = PKG.exec(value);
    if (!pkg) {
      // The affected-all base `--filter="...[origin/$BASE_REF]"` names no
      // package; it is the `rest` shard's selection root, not a partition
      // member, so it is intentionally ignored here.
      continue;
    }
    (value.includes('!') ? negations : positives).add(pkg[1]);
  }
  return { negations: [...negations].sort(), positives: [...positives].sort() };
}

const eqSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Validates the partition invariant. Returns a list of human-readable failure
 * strings (empty === valid).
 * @param {ReturnType<typeof parseUnitShardMatrix>} matrix
 * @returns {string[]}
 */
export function validateUnitShardPartition(matrix) {
  const failures = [];
  const shardLabels = new Set();
  const byPartition = new Map();

  // pr and push filter modes must select the same packages, or a package is
  // covered on PRs but silently dropped on push (or vice-versa).
  for (const s of matrix) {
    if (shardLabels.has(s.shard)) {
      failures.push(`physical shard label "${s.shard}" is duplicated`);
    }
    shardLabels.add(s.shard);
    const rows = byPartition.get(s.partition) ?? [];
    rows.push(s);
    byPartition.set(s.partition, rows);

    if (!eqSet(s.pr.positives, s.push.positives)) {
      failures.push(
        `shard "${s.shard}": pr positives [${s.pr.positives}] != push positives [${s.push.positives}]`
      );
    }
    if (!eqSet(s.pr.negations, s.push.negations)) {
      failures.push(
        `shard "${s.shard}": pr negations [${s.pr.negations}] != push negations [${s.push.negations}]`
      );
    }
  }

  for (const [partition, rows] of byPartition) {
    const baseline = rows[0];
    for (const row of rows.slice(1)) {
      for (const mode of ['pr', 'push']) {
        if (
          !(
            eqSet(baseline[mode].positives, row[mode].positives) &&
            eqSet(baseline[mode].negations, row[mode].negations)
          )
        ) {
          failures.push(
            `logical partition "${partition}" has divergent ${mode} filters between ` +
              `"${baseline.shard}" and "${row.shard}"`
          );
        }
      }
    }

    const nativeShards = rows.filter((row) => row.vitestShard !== null);
    if (nativeShards.length === 0) {
      if (rows.length > 1) {
        failures.push(
          `logical partition "${partition}" has ${rows.length} physical rows but no native Vitest shard specs`
        );
      }
      continue;
    }
    if (nativeShards.length !== rows.length) {
      failures.push(`logical partition "${partition}" mixes sharded and unsharded rows`);
      continue;
    }
    const counts = [...new Set(nativeShards.map((row) => row.vitestShard.count))];
    if (counts.length !== 1) {
      failures.push(
        `logical partition "${partition}" has inconsistent native shard counts [${counts}]`
      );
      continue;
    }
    const count = counts[0];
    const indices = nativeShards.map((row) => row.vitestShard.index).sort((a, b) => a - b);
    const expected = Array.from({ length: count }, (_, index) => index + 1);
    if (!eqSet(indices, expected)) {
      failures.push(
        `logical partition "${partition}" native shards must be exactly 1/${count}..${count}/${count}; ` +
          `found indices [${indices}]`
      );
    }
  }

  const restRows = byPartition.get('rest');
  if (!restRows) {
    failures.push('no "rest" logical partition found');
    return failures;
  }
  if (restRows.length !== 1 || restRows[0].vitestShard !== null) {
    failures.push('the "rest" logical partition must be one unsharded physical row');
  }
  const rest = restRows[0];
  const positivePartitions = [...byPartition.entries()].filter(([name]) => name !== 'rest');

  // A package must never appear positively in two logical partitions. Repeated
  // physical rows inside one native Vitest partition are intentional.
  const seen = new Map();
  for (const [partition, rows] of positivePartitions) {
    const s = rows[0];
    for (const pkg of s.pr.positives) {
      if (seen.has(pkg)) {
        failures.push(
          `package "${pkg}" is positively owned by both "${seen.get(pkg)}" and "${partition}"`
        );
      }
      seen.set(pkg, partition);
    }
    if (s.pr.negations.length > 0) {
      failures.push(
        `logical partition "${partition}" should carry no negations, has [${s.pr.negations}]`
      );
    }
  }

  // rest must own no positive packages (only the affected-all base).
  if (rest.pr.positives.length > 0) {
    failures.push(
      `"rest" shard should carry no positive package filters, has [${rest.pr.positives}]`
    );
  }

  // The core invariant: rest's negations == the union of every other shard's positives.
  const unionPositives = [...seen.keys()].sort();
  if (!eqSet(rest.pr.negations, unionPositives)) {
    const missing = unionPositives.filter((p) => !rest.pr.negations.includes(p));
    const extra = rest.pr.negations.filter((p) => !unionPositives.includes(p));
    failures.push(
      `"rest" negations must equal the union of positive logical partitions. ` +
        `missing negations (double-tested): [${missing}]; ` +
        `extra negations (UNTESTED — owned by no shard): [${extra}]`
    );
  }

  return failures;
}
