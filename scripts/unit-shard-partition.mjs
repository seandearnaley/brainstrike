// Guard for the `unit-shard` matrix partition in .github/workflows/test.yml.
//
// The Unit job is split across three shards (db / heavy / rest) whose turbo
// `--filter`s must form an exact partition of the affected package set:
//   - db + heavy list packages POSITIVELY (`--filter=@brainstrike/x`)
//   - rest runs the affected-all base MINUS every package the other shards own
//     (`--filter="...[ref]"` then one `--filter="!@brainstrike/x"` per package)
//
// The dangerous drift is silent: if a package is negated out of `rest` but
// never given a positive shard (or a positive package is dropped without
// removing its `rest` negation), it stops being tested entirely — and the
// fan-in `Unit` check still passes because each shard no-ops cleanly. This
// parses the matrix and asserts the partition holds, converting a comment-only
// invariant into a checked contract.

const PKG = /@brainstrike\/([a-z0-9-]+)/;

/**
 * Extracts the `unit-shard` matrix include block and returns, per shard, the
 * positive and negation @brainstrike package-name sets for both pr and push
 * filter modes.
 * @param {string} yamlText full contents of test.yml
 * @returns {{ shard: string, pr: {positives: string[], negations: string[]}, push: {positives: string[], negations: string[]} }[]}
 */
export function parseUnitShardMatrix(yamlText) {
  const includeStart = yamlText.indexOf('matrix:');
  if (includeStart === -1) {
    throw new Error('unit-shard matrix block not found in workflow');
  }
  // The matrix lives between `matrix:` and the job's `steps:` key (4-space
  // indent). Slicing to `\n    steps:` keeps later jobs' filters out of scope.
  const stepsIdx = yamlText.indexOf('\n    steps:', includeStart);
  const block = yamlText.slice(includeStart, stepsIdx === -1 ? undefined : stepsIdx);

  // Split into per-shard chunks on the `- shard: <name>` list markers.
  const parts = block.split(/-\s*shard:\s*/).slice(1);
  if (parts.length === 0) {
    throw new Error('no `- shard:` entries found in unit-shard matrix');
  }

  return parts.map((part) => {
    const shard = part.split('\n', 1)[0].trim();
    const prBlock = sliceKey(part, 'pr_filters', 'push_filters');
    const pushBlock = sliceKey(part, 'push_filters', null);
    return { pr: classifyFilters(prBlock), push: classifyFilters(pushBlock), shard };
  });
}

function sliceKey(text, key, nextKey) {
  const start = text.indexOf(`${key}:`);
  if (start === -1) {
    return '';
  }
  const end = nextKey ? text.indexOf(`${nextKey}:`, start) : -1;
  return text.slice(start, end === -1 ? undefined : end);
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
  const byShard = new Map(matrix.map((s) => [s.shard, s]));

  // pr and push filter modes must select the same packages, or a package is
  // covered on PRs but silently dropped on push (or vice-versa).
  for (const s of matrix) {
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

  const rest = byShard.get('rest');
  if (!rest) {
    failures.push('no "rest" shard found');
    return failures;
  }
  const positiveShards = matrix.filter((s) => s.shard !== 'rest');

  // A package must never appear positively in two shards.
  const seen = new Map();
  for (const s of positiveShards) {
    for (const pkg of s.pr.positives) {
      if (seen.has(pkg)) {
        failures.push(
          `package "${pkg}" is positively owned by both "${seen.get(pkg)}" and "${s.shard}"`
        );
      }
      seen.set(pkg, s.shard);
    }
    if (s.pr.negations.length > 0) {
      failures.push(`shard "${s.shard}" should carry no negations, has [${s.pr.negations}]`);
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
      `"rest" negations must equal the union of db+heavy positives. ` +
        `missing negations (double-tested): [${missing}]; ` +
        `extra negations (UNTESTED — owned by no shard): [${extra}]`
    );
  }

  return failures;
}
