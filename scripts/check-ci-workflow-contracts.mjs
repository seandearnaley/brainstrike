#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const workflowPath = path.join(rootDir, '.github/workflows/test.yml');

function extractBlock(source, startPattern, nextPattern) {
  const start = source.search(startPattern);
  if (start === -1) {
    return null;
  }

  const rest = source.slice(start);
  const next = rest.search(nextPattern);
  return next === -1 ? rest : rest.slice(0, next);
}

export function extractJob(source, jobName) {
  return extractBlock(source, new RegExp(`^  ${escapeRegExp(jobName)}:\\s*$`, 'm'), /\n  [a-zA-Z0-9_.-]+:\s*$/m);
}

function requireMatch(source, pattern, message, failures) {
  if (!pattern.test(source)) {
    failures.push(message);
  }
}

function requireIncludes(source, text, message, failures) {
  if (!source.includes(text)) {
    failures.push(message);
  }
}

function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requireYamlListItem(source, item, message, failures) {
  requireMatch(source, new RegExp(`^\\s+- ${escapeRegExp(item)}\\s*$`, 'm'), message, failures);
}

function extractNamedStepBlocks(source, namePattern) {
  const lines = source.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s+- name:\s*/.test(line) || !namePattern.test(line)) {
      continue;
    }

    const blockLines = [line];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^\s+- name:\s*/.test(lines[cursor])) {
        break;
      }
      blockLines.push(lines[cursor]);
    }
    blocks.push(blockLines.join('\n'));
  }

  return blocks;
}

export function validateWorkflowContracts(source) {
  const failures = [];

  requireMatch(
    source,
    /concurrency:[\s\S]*cancel-in-progress:\s*\$\{\{\s*github\.event_name == 'pull_request'\s*\}\}/,
    'Test workflow must cancel superseded pull_request runs.',
    failures
  );

  // Shard count is intentionally enforced in the workflow and this lint so CI
  // wall-time/cost changes are reviewed as explicit contract changes.
  const determineMatrix = extractJob(source, 'determine-matrix');
  if (!determineMatrix) {
    failures.push('Missing determine-matrix job.');
  } else {
    requireIncludes(
      determineMatrix,
      'web-shards=["1","2","3","4","5"]',
      'Functional web E2E matrix must stay at five shards.',
      failures
    );
    requireIncludes(
      determineMatrix,
      'web-shard-total=["5"]',
      'Functional web E2E shard total must stay at five.',
      failures
    );
  }

  const e2e = extractJob(source, 'e2e');
  if (!e2e) {
    failures.push('Missing e2e job.');
  } else {
    requireIncludes(
      e2e,
      'needs: [checks, determine-matrix]',
      'Functional E2E must depend on checks and determine-matrix.',
      failures
    );
    requireIncludes(
      e2e,
      '--workers=2',
      'Functional E2E must keep two workers per shard.',
      failures
    );
    requireIncludes(
      e2e,
      '--grep-invert "@destructive|@stateful"',
      'Functional E2E must exclude isolated @destructive and @stateful specs.',
      failures
    );
    requireIncludes(
      e2e,
      '--shard=${{ matrix.shardIndex }}/${{ matrix.shardTotal }}',
      'Functional E2E must run the configured shard.',
      failures
    );
  }

  const stateful = extractJob(source, 'e2e-stateful');
  if (!stateful) {
    failures.push('Missing e2e-stateful job.');
  } else {
    requireIncludes(
      stateful,
      'needs: [checks]',
      'Stateful E2E must not wait on determine-matrix.',
      failures
    );
    requireIncludes(
      stateful,
      '--workers=1 --grep "@stateful"',
      'Stateful E2E must run tagged specs in a one-worker lane.',
      failures
    );
  }

  const destructive = extractJob(source, 'e2e-destructive');
  if (!destructive) {
    failures.push('Missing e2e-destructive job.');
  } else {
    requireIncludes(
      destructive,
      'needs: [checks]',
      'Destructive E2E must not wait on determine-matrix.',
      failures
    );
    requireIncludes(
      destructive,
      '--workers=1 --grep "@destructive"',
      'Destructive E2E must run tagged specs in a one-worker lane.',
      failures
    );
  }

  const requiredPrGate = extractJob(source, 'required-pr-gate');
  if (!requiredPrGate) {
    failures.push('Missing required-pr-gate job.');
  } else {
    requireIncludes(
      requiredPrGate,
      'name: Required PR Gate',
      'Required PR Gate status name must stay stable for branch rulesets.',
      failures
    );
    for (const jobName of [
      'checks',
      'unit_coverage',
      'browser-tests',
      'prepare-web',
      'prepare-desktop',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-pr',
      'merge-reports',
    ]) {
      requireYamlListItem(
        requiredPrGate,
        jobName,
        `Required PR Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredPrGate,
      "job.result !== 'success'",
      'Required PR Gate must fail unless every dependency succeeds.',
      failures
    );
  }

  const requiredMainGate = extractJob(source, 'required-main-gate');
  if (!requiredMainGate) {
    failures.push('Missing required-main-gate job.');
  } else {
    requireIncludes(
      requiredMainGate,
      'name: Required Main Gate',
      'Required Main Gate status name must stay stable for branch rulesets.',
      failures
    );
    for (const jobName of [
      'checks',
      'unit_coverage',
      'browser-tests',
      'prepare-web',
      'prepare-desktop',
      'e2e',
      'e2e-stateful',
      'e2e-destructive',
      'desktop-e2e-main',
      'merge-reports',
    ]) {
      requireYamlListItem(
        requiredMainGate,
        jobName,
        `Required Main Gate must depend on ${jobName}.`,
        failures
      );
    }
    requireIncludes(
      requiredMainGate,
      "job.result !== 'success'",
      'Required Main Gate must fail unless every dependency succeeds.',
      failures
    );
  }

  const blobUploadBlocks = extractNamedStepBlocks(source, /Upload .*blob report/i);
  if (blobUploadBlocks.length === 0) {
    failures.push('Missing Playwright blob report upload steps.');
  }
  for (const block of blobUploadBlocks) {
    requireIncludes(block, 'if: failure()', 'Blob report uploads must be failure-only.', failures);
    requireIncludes(block, 'retention-days: 1', 'Blob report uploads must retain for one day.', failures);
  }

  return failures;
}

export async function main() {
  const source = await readFile(workflowPath, 'utf8');
  const failures = validateWorkflowContracts(source);

  if (failures.length > 0) {
    console.error('CI workflow contract check failed.');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('CI workflow contract check passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
