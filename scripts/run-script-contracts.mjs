import { realpathSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

import { loadRepositoryContract } from './verify-guard-inventory.mjs';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function validateContractEvidence(contractPaths, events, repoRoot) {
  const passedFiles = new Set(
    events
      .filter(
        (event) =>
          event.type === 'test:pass' &&
          event.data?.details?.type === 'test' &&
          !event.data?.skip &&
          !event.data?.todo &&
          event.data?.name !== event.data?.file
      )
      .map((event) => path.relative(repoRoot, event.data.file).split(path.sep).join('/'))
  );

  return contractPaths
    .filter((contractPath) => !passedFiles.has(contractPath))
    .map((contractPath) => `${contractPath}: inventory contract has no non-skipped passing test`);
}

export async function main({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const contract = await loadRepositoryContract(repoRoot);
  if (contract.issues.length > 0) {
    console.error('Warden guard inventory verification failed:');
    for (const issue of contract.issues) {
      console.error(`- ${issue}`);
    }
    process.exitCode = 1;
    return;
  }

  const files = contract.testPaths.map((relativePath) => path.join(repoRoot, relativePath));
  const events = [];
  const reporterInput = new PassThrough({ objectMode: true });
  const reporter = reporterInput.compose(spec());
  reporter.pipe(process.stdout, { end: false });

  for await (const event of run({ files })) {
    events.push(event);
    reporterInput.write(event);
  }
  reporterInput.end();
  await finished(reporter);

  const evidenceIssues = validateContractEvidence(contract.contractPaths, events, repoRoot);
  for (const issue of evidenceIssues) {
    console.error(`Warden contract evidence failed: ${issue}`);
  }

  const summary = events.findLast(
    (event) => event.type === 'test:summary' && event.data?.file === undefined
  );
  if (summary?.data?.success !== true || evidenceIssues.length > 0) {
    process.exitCode = 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Warden script contract runner failed:');
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
