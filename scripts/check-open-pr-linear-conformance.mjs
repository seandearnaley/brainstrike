#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEAR_REFERENCE = /\bBST-\d+\b/;
const EXCLUDED_DEPENDENCY_BOTS = new Set(['dependabot[bot]', 'renovate[bot]']);

function assertPullRequest(value, index) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`GitHub returned a non-object PR at index ${index}.`);
  }
  if (!Number.isInteger(value.number) || typeof value.title !== 'string') {
    throw new TypeError(`GitHub returned an invalid number or title for PR at index ${index}.`);
  }
  if (value.body !== null && typeof value.body !== 'string') {
    throw new TypeError(`GitHub returned an invalid body for PR #${value.number}.`);
  }
  if (typeof value.url !== 'string') {
    throw new TypeError(`GitHub returned an invalid URL for PR #${value.number}.`);
  }
  const login = value.author?.login;
  if (typeof login !== 'string') {
    throw new TypeError(`GitHub returned no author login for PR #${value.number}.`);
  }
  return value;
}

export function findUnlinkedPullRequests(pullRequests) {
  if (!Array.isArray(pullRequests)) {
    throw new TypeError('Expected GitHub to return an array of open pull requests.');
  }

  const findings = [];
  for (const [index, candidate] of pullRequests.entries()) {
    const pullRequest = assertPullRequest(candidate, index);
    if (EXCLUDED_DEPENDENCY_BOTS.has(pullRequest.author.login)) {
      continue;
    }
    if (LINEAR_REFERENCE.test(pullRequest.body ?? '')) {
      continue;
    }
    findings.push(pullRequest);
  }
  return findings;
}

export function formatConformanceReport(findings) {
  if (!Array.isArray(findings)) {
    throw new TypeError('Expected an array of conformance findings.');
  }
  if (findings.length === 0) {
    return 'All inspected open PR descriptions reference `BST-###`. No PRs were modified.';
  }

  const lines = [
    `Found ${findings.length} open PR description(s) without a Brainstrike issue reference:`,
    '',
  ];
  for (const finding of findings) {
    lines.push(
      `- #${finding.number} ${finding.title}`,
      `  ${finding.url}`,
      '  Suggested action: add `BST-###` (or a Linear issue URL containing it) to the PR description.'
    );
  }
  lines.push('', 'This check is warning only; no PRs were modified.');
  return lines.join('\n');
}

function listOpenPullRequests() {
  const result = spawnSync(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,body,author,isDraft,url',
    ],
    { encoding: 'utf8' }
  );

  if (result.error) {
    throw new Error(`Unable to run GitHub CLI: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`GitHub CLI failed with exit ${result.status}: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error('GitHub CLI returned malformed JSON.', { cause: error });
  }
}

export function main() {
  const findings = findUnlinkedPullRequests(listOpenPullRequests());
  process.stdout.write(`${formatConformanceReport(findings)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
