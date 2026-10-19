#!/usr/bin/env node

// Prints, for $GITHUB_OUTPUT, the actions/download-artifact pattern that
// selects one nightly workflow's test results (BST-2233):
//
//   node scripts/nightly-results-artifacts.mjs --results <job=result,...>
//
// --results is the input Notify Linear files from. Every workflow nightly.yml
// calls shares that run's artifacts, so Notify Linear downloads the results of
// the jobs it reports and no sibling's. Exits 1, printing nothing, on bad input.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resultsArtifactPattern } from './lib/nightly-test-results.mjs';
import { parseResults } from './notify-linear-nightly.mjs';

/**
 * @returns {number} the process exit code: 0, or 1 on any failure.
 */
export function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const { values } = parseArgs({
      allowPositionals: false,
      args: argv,
      options: { results: { type: 'string' } },
      strict: true,
    });
    if (!values.results) {
      throw new Error('Missing required argument --results.');
    }
    const jobs = parseResults(values.results).map(({ job }) => job);
    stdout.write(`pattern=${resultsArtifactPattern(jobs)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`nightly-results-artifacts: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
