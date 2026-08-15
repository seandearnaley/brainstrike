#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEAR_REFERENCE = /\bBST-\d+\b/;
const EXCLUDED_DEPENDENCY_BOTS = new Set(['dependabot[bot]', 'renovate[bot]']);

export const GITHUB_OPEN_PULL_REQUEST_ARGS = Object.freeze([
  'api',
  '--paginate',
  '--slurp',
  '--method',
  'GET',
  'repos/{owner}/{repo}/pulls',
  '-f',
  'state=open',
  '-F',
  'per_page=100',
]);

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

export function normalizeOpenPullRequestPages(pages) {
  if (!Array.isArray(pages)) {
    throw new TypeError('Expected GitHub pagination to return an array of pages.');
  }

  const pullRequests = [];
  for (const [pageIndex, page] of pages.entries()) {
    if (!Array.isArray(page)) {
      throw new TypeError(`GitHub returned a non-array PR page at index ${pageIndex}.`);
    }
    for (const candidate of page) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        throw new TypeError(`GitHub returned a non-object PR on page ${pageIndex}.`);
      }
      pullRequests.push({
        author: { login: candidate.user?.login },
        body: candidate.body,
        number: candidate.number,
        title: candidate.title,
        url: candidate.html_url,
      });
    }
  }
  return pullRequests;
}

export function collectChildProcessOutput(child) {
  if (!(child?.stdout && child.stderr) || typeof child.once !== 'function') {
    throw new TypeError('Expected a child process with piped stdout and stderr.');
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.once('error', rejectPromise);
    child.stderr.once('error', rejectPromise);
    child.once('error', rejectPromise);
    child.once('close', (status, signal) => {
      resolvePromise({ signal, status, stderr, stdout });
    });
  });
}

async function listOpenPullRequests() {
  let result;
  try {
    result = await collectChildProcessOutput(spawn('gh', GITHUB_OPEN_PULL_REQUEST_ARGS));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to run GitHub CLI: ${message}`, { cause: error });
  }

  if (result.status !== 0) {
    const termination = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`GitHub CLI failed with ${termination}: ${result.stderr.trim()}`);
  }

  try {
    return normalizeOpenPullRequestPages(JSON.parse(result.stdout));
  } catch (error) {
    throw new Error('GitHub CLI returned malformed JSON.', { cause: error });
  }
}

export async function main() {
  const findings = findUnlinkedPullRequests(await listOpenPullRequests());
  process.stdout.write(`${formatConformanceReport(findings)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
