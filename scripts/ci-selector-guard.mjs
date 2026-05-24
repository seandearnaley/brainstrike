#!/usr/bin/env node

import {
  collectGitSelection,
  parseSelectArgs,
} from './ci-select.mjs';
import { verifyRiskFixtures } from './check-ci-risk-fixtures.mjs';
import riskFixtures from './ci-risk-fixtures.json' with { type: 'json' };

const E2E_PROOF_COMMAND_LABELS = new Map([
  ['web-smoke-tests', 'ci:web-smoke'],
  ['web-file-explorer-persistence-tests', 'ci:web-file-explorer-persistence'],
  ['web-import-indexing-tests', 'ci:web-import-indexing'],
  ['web-assistant-state-tests', 'ci:web-assistant-state'],
  ['web-settings-state-tests', 'ci:web-settings-state'],
  ['web-db-startup-tests', 'ci:web-db-startup'],
  ['web-destructive-reset-tests', 'ci:web-destructive-reset'],
  ['web-full-regression-tests', 'ci:web-e2e'],
  ['desktop-smoke-tests', 'ci:desktop-smoke'],
  ['desktop-ipc-reset-tests', 'ci:desktop-ipc-reset'],
  ['desktop-runtime-host-tests', 'ci:desktop-runtime-hosts'],
  ['desktop-db-storage-tests', 'ci:desktop-db-storage'],
  ['desktop-full-regression-tests', 'ci:desktop'],
]);

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function formatLabels(labels) {
  return labels.length > 0 ? labels.join(',') : '<none>';
}

export function verifySelectorSelection(selection) {
  const failures = [];
  const labels = selection.labels ?? [];
  const lanes = selection.lanes ?? [];
  const profileLabels = selection.riskProfile?.cloudLabels ?? [];

  if (!sameArray(labels, lanes)) {
    failures.push(
      `selection labels and lanes disagree: labels=${formatLabels(labels)} lanes=${formatLabels(lanes)}`
    );
  }
  if (!sameArray(profileLabels, labels)) {
    failures.push(
      `risk profile and selected labels disagree: profile=${formatLabels(
        profileLabels
      )} labels=${formatLabels(labels)}`
    );
  }

  if (selection.riskProfile?.category === 'docs-only') {
    if (labels.length > 0) {
      failures.push(`docs-only selection must not request cloud labels: ${formatLabels(labels)}`);
    }
    const commandNames = selection.commands.map((command) => command.name);
    if (!sameArray(commandNames, ['diff-check', 'docs-static'])) {
      failures.push(`docs-only proof must stay diff-check/docs-static: ${commandNames.join(',')}`);
    }
  }

  const hasFull = labels.includes('ci:full');
  if (hasFull && labels.length !== 1) {
    failures.push(`ci:full must be the only selected label: ${formatLabels(labels)}`);
  }

  for (const command of selection.commands) {
    const requiredLabel = E2E_PROOF_COMMAND_LABELS.get(command.name);
    if (!requiredLabel) {
      continue;
    }
    if (!hasFull && !labels.includes(requiredLabel)) {
      failures.push(
        `${command.name} requires ${requiredLabel}, but selected labels are ${formatLabels(labels)}`
      );
    }
  }

  return failures;
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseSelectArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const fixtureFailures = verifyRiskFixtures(riskFixtures);
  if (fixtureFailures.length > 0) {
    console.error(`CI selector guard failed risk fixtures:\n${fixtureFailures.join('\n')}`);
    return 1;
  }

  let selection;
  try {
    selection = await collectGitSelection(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const selectionFailures = verifySelectorSelection(selection);
  if (selectionFailures.length > 0) {
    console.error(`CI selector guard failed current diff:\n${selectionFailures.join('\n')}`);
    return 1;
  }

  console.log(
    `CI selector guard passed: ${selection.riskProfile.category}; labels=${formatLabels(
      selection.labels
    )}; commands=${selection.commands.map((command) => command.name).join(',')}`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
