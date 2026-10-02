// PR #3461: empty affected partitions previously provisioned a paid runner
// before Turbo discovered that neither Unit phase had work. Preview the same
// native Turbo commands; the workflow remains the sole owner of matrix rows.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function unitFilterArguments(filters) {
  if (typeof filters !== 'string' || filters.trim() === '') {
    throw new Error('Missing Unit package filters');
  }
  return filters
    .trim()
    .split(/\s+/u)
    .map((filter) => {
      const match = /^--filter="(!?@brainstrike\/[a-z0-9-]+)"$/u.exec(filter);
      if (!match) {
        throw new Error(`Unsupported Unit package filter: ${filter}`);
      }
      return `--filter=${match[1]}`;
    });
}

export function hasUnitTasks(summary) {
  if (summary?.version !== '1' || !Array.isArray(summary.tasks)) {
    throw new Error('Invalid Turbo dry-run summary');
  }
  let hasTests = false;
  for (const task of summary.tasks) {
    if (
      typeof task?.task !== 'string' ||
      typeof task.package !== 'string' ||
      typeof task.command !== 'string' ||
      task.command.trim() === ''
    ) {
      throw new Error('Invalid task in Turbo dry-run summary');
    }
    if (
      (task.task === 'test' || task.task === 'test:integration') &&
      task.command !== '<NONEXISTENT>'
    ) {
      hasTests = true;
    }
  }
  return hasTests;
}

export function selectUnitShards(matrix, eventName, preview) {
  if (!Array.isArray(matrix?.include) || matrix.include.length === 0) {
    throw new Error('Missing full Unit matrix');
  }
  if (!['pull_request', 'push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error(`Unsupported Unit event: ${eventName}`);
  }
  if (eventName !== 'pull_request') {
    return matrix;
  }
  const selections = new Map();
  const include = matrix.include.filter((row) => {
    const filters = unitFilterArguments(row.pr_filters);
    const key = JSON.stringify(filters);
    if (!selections.has(key)) {
      // Native Vitest shards share package selection. Both phases matter:
      // an integration-only change must still admit its complete shard set.
      selections.set(key, hasUnitTasks(preview(filters)));
    }
    return selections.get(key);
  });
  return { include };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (
    process.env.EVENT_NAME === 'pull_request' &&
    !(process.env.TURBO_SCM_BASE && process.env.TURBO_SCM_HEAD)
  ) {
    throw new Error('Exact PR base and tested head are required for Unit selection');
  }
  const matrix = selectUnitShards(
    JSON.parse(process.env.UNIT_MATRIX),
    process.env.EVENT_NAME,
    (filters) =>
      JSON.parse(
        execFileSync(
          'pnpm',
          [
            '-s',
            'exec',
            'turbo',
            'run',
            'test',
            'test:integration',
            ...filters,
            '--affected',
            '--dry=json',
          ],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
        )
      )
  );
  // Do not publish an empty-success output until EVERY dry-run has succeeded
  // and parsed. A command error or changed schema fails Static and Unit.
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify(matrix)}\ncount=${matrix.include.length}\n`
  );
  console.log(
    `Selected ${matrix.include.length} Unit shards: ${matrix.include.map((row) => row.shard).join(', ')}`
  );
}
