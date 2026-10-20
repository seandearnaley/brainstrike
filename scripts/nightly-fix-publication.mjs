#!/usr/bin/env node
// Deterministic GitHub publication around the read-only nightly agent.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const REPO = /^[\w.-]+\/[\w.-]+$/u;
export const RETAINED_PREFIX = 'Fix patch retained: ';

function command(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
    }).trim();
  } catch (error) {
    throw new Error(`${executable} ${args[0]} failed (exit ${error.status ?? 'unavailable'}).`, {
      cause: error,
    });
  }
}
export function githubApi(endpoint, fields = {}, paginate = false) {
  return JSON.parse(
    command('gh', [
      'api',
      '--method',
      'GET',
      ...(paginate ? ['--paginate', '--slurp'] : []),
      endpoint,
      ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
    ])
  );
}
function list(endpoint, fields, github) {
  const pages = github(endpoint, fields, true);
  if (!(Array.isArray(pages) && pages.every(Array.isArray))) {
    throw new Error('GitHub returned malformed paginated results.');
  }
  return pages.flat();
}
export function validateReceipt(value) {
  if (
    !(
      value &&
      value.version === 1 &&
      /^BST-\d+$/u.test(value.issue) &&
      REPO.test(value.repository) &&
      /^\d+$/u.test(value.runId) &&
      value.claimant === `github-run:${value.runId}` &&
      [value.baseSha, value.headSha, value.controlSha].every((sha) => SHA.test(sha)) &&
      value.branch === `nightly-fix/${value.issue.toLowerCase()}-${value.runId}` &&
      Number.isSafeInteger(value.artifactId) &&
      value.artifactId > 0 &&
      /^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest) &&
      Number.isFinite(Date.parse(value.expiresAt))
    )
  ) {
    throw new Error('Invalid retained patch receipt.');
  }
  return value;
}
function core(env) {
  const value = {
    artifactDigest: `sha256:${env.ARTIFACT_DIGEST}`,
    artifactId: Number(env.ARTIFACT_ID),
    baseSha: env.BASE_SHA,
    branch: `nightly-fix/${env.ISSUE?.toLowerCase()}-${env.GITHUB_RUN_ID}`,
    claimant: `github-run:${env.GITHUB_RUN_ID}`,
    controlSha: env.CONTROL_SHA,
    headSha: env.PATCH_SHA,
    issue: env.ISSUE,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    version: 1,
  };
  if (
    !(
      REPO.test(value.repository) &&
      /^BST-\d+$/u.test(value.issue) &&
      [value.baseSha, value.headSha, value.controlSha].every((sha) => SHA.test(sha)) &&
      /^\d+$/u.test(value.runId) &&
      Number.isSafeInteger(value.artifactId) &&
      value.artifactId > 0 &&
      /^sha256:[0-9a-f]{64}$/u.test(value.artifactDigest)
    )
  ) {
    throw new Error('Invalid publication identity.');
  }
  return value;
}
function exactPr(receipt, github) {
  const pulls = list(
    `repos/${receipt.repository}/pulls`,
    {
      head: `${receipt.repository.split('/')[0]}:${receipt.branch}`,
      per_page: '100',
      state: 'all',
    },
    github
  );
  if (pulls.length > 1) {
    throw new Error('Several PRs use the retained branch; owner reconciliation required.');
  }
  const pr = pulls[0];
  if (!pr) {
    return;
  }
  if (
    !(
      Number.isSafeInteger(pr.number) &&
      pr.head?.ref === receipt.branch &&
      pr.head?.repo?.full_name === receipt.repository &&
      pr.head?.sha === receipt.headSha &&
      pr.base?.ref === 'main' &&
      pr.html_url === `https://github.com/${receipt.repository}/pull/${pr.number}`
    )
  ) {
    throw new Error('The existing PR does not match the exact retained branch/head/base.');
  }
  return pr;
}
/** A missing artifact is not permission to generate another fix. */
export function retainedPatchEvidence(receipt, github = githubApi, now = Date.now()) {
  validateReceipt(receipt);
  const pr = exactPr(receipt, github);
  if (pr) {
    return { available: true, detail: pr.html_url };
  }
  const refs = github(`repos/${receipt.repository}/git/matching-refs/heads/${receipt.branch}`);
  if (!Array.isArray(refs)) {
    throw new Error('GitHub returned malformed branch references.');
  }
  const ref = refs.find((entry) => entry.ref === `refs/heads/${receipt.branch}`);
  if (ref) {
    if (ref.object?.sha !== receipt.headSha) {
      throw new Error('The retained branch head changed; owner reconciliation required.');
    }
    return {
      available: true,
      detail: `https://github.com/${receipt.repository}/tree/${receipt.branch}`,
    };
  }
  const artifacts = list(
    `repos/${receipt.repository}/actions/runs/${receipt.runId}/artifacts`,
    { per_page: '100' },
    github
  );
  const artifact = artifacts.find((entry) => entry.id === receipt.artifactId);
  if (
    artifact &&
    artifact.name === `nightly-fix--${receipt.issue}` &&
    artifact.expired === false &&
    artifact.digest === receipt.artifactDigest &&
    Date.parse(artifact.expires_at) > now &&
    artifact.expires_at === receipt.expiresAt &&
    artifact.workflow_run?.head_sha === receipt.controlSha
  ) {
    return {
      available: true,
      detail:
        'https://github.com/' +
        receipt.repository +
        '/actions/runs/' +
        receipt.runId +
        '/artifacts/' +
        receipt.artifactId,
    };
  }
  return {
    available: false,
    detail:
      'Artifact ' +
      receipt.artifactId +
      ' expired/unavailable (' +
      receipt.expiresAt +
      '); no matching branch or PR exists. Manual recovery required; no automatic regeneration.',
  };
}
function artifactReceipt(env, github) {
  const receipt = core(env);
  const artifact = github(`repos/${receipt.repository}/actions/artifacts/${receipt.artifactId}`);
  if (
    !(
      artifact?.id === receipt.artifactId &&
      artifact.name === `nightly-fix--${receipt.issue}` &&
      artifact.expired === false &&
      artifact.digest === receipt.artifactDigest &&
      Date.parse(artifact.expires_at) > Date.now() &&
      artifact.workflow_run?.head_sha === receipt.controlSha
    )
  ) {
    throw new Error('The patch artifact is expired or does not match the workflow control SHA.');
  }
  return validateReceipt({ ...receipt, expiresAt: artifact.expires_at });
}
function output(env, key, value) {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
function save(env, receipt, status, detail) {
  const dir = join(env.RUNNER_TEMP, 'nightly-fix');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'retained.json'),
    `${JSON.stringify({ ...receipt, detail, status }, null, 2)}\n`
  );
  output(env, 'retained', 'true');
  const message =
    'Patch ' +
    receipt.headSha +
    '; branch https://github.com/' +
    receipt.repository +
    '/tree/' +
    receipt.branch +
    '; artifact expires ' +
    receipt.expiresAt +
    '.\n' +
    detail +
    '\nIssue remains owned; an owner must recover/review it, never automatically regenerate it.';
  writeFileSync(join(dir, 'blocked.md'), message);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}
export function publication(mode, env = process.env, github = githubApi) {
  if (!['artifact', 'reconcile', 'publish'].includes(mode)) {
    throw new Error('Expected artifact, reconcile or publish mode.');
  }
  const dir = join(env.RUNNER_TEMP, 'nightly-fix');
  mkdirSync(dir, { recursive: true });
  if (mode === 'artifact') {
    const receipt = artifactReceipt(env, github);
    save(
      env,
      receipt,
      'awaiting-publication',
      'Patch artifact retained; publication may wait in the repository-wide queue.'
    );
    return;
  }
  const receipt = core(env);
  if (
    !(
      REPO.test(receipt.repository) &&
      /^BST-\d+$/u.test(receipt.issue) &&
      [receipt.baseSha, receipt.headSha, receipt.controlSha].every((sha) => SHA.test(sha)) &&
      /^\d+$/u.test(receipt.runId)
    )
  ) {
    throw new Error('Invalid publication identity.');
  }
  const existing = exactPr(receipt, github);
  if (existing) {
    if (existing.state !== 'open') {
      throw new Error(
        'Existing PR ' +
          existing.html_url +
          ' is ' +
          existing.state +
          '; owner action required, no automatic reopen.'
      );
    }
    output(env, 'url', existing.html_url);
    return;
  }
  if (mode === 'reconcile') {
    return;
  }
  if (mode !== 'publish') {
    throw new Error('Expected artifact, reconcile or publish mode.');
  }
  const retained = artifactReceipt(env, github);
  const pr = readFileSync(join(dir, 'pr.md'), 'utf8').split('\n');
  const title = pr.shift();
  if (!title?.endsWith(`(${receipt.issue})`)) {
    throw new Error('The PR title must end with the exact issue identifier.');
  }
  const ref = `refs/heads/${receipt.branch}`;
  command('git', ['fetch', join(dir, 'fix.bundle'), `HEAD:${ref}`]);
  if (command('git', ['rev-parse', ref]) !== receipt.headSha) {
    throw new Error('Bundle head differs from the retained patch SHA.');
  }
  command('git', ['merge-base', '--is-ancestor', receipt.baseSha, ref]);
  command('git', ['push', 'origin', `${ref}:${ref}`]);
  save(env, retained, 'prepared', 'Verified patch branch pushed; checking publication capacity.');
  try {
    const open = list(
      `repos/${receipt.repository}/pulls`,
      { per_page: '100', state: 'open' },
      github
    );
    if (!open.every((entry) => Number.isSafeInteger(entry?.number) && entry.state === 'open')) {
      throw new Error('GitHub returned malformed open PRs.');
    }
    if (open.length + 1 + 1 > 5) {
      throw new Error(
        'Publication blocked: ' +
          open.length +
          ' open PRs + candidate + reserved queue slot exceeds five. Every draft/bot counts.'
      );
    }
    const body = join(dir, 'pr-body.md');
    writeFileSync(body, `Fixes ${receipt.issue}\n\n${pr.join('\n')}`);
    const url = command('gh', [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      receipt.branch,
      '--title',
      title,
      '--body-file',
      body,
    ]);
    if (!new RegExp(`^https://github\\.com/${receipt.repository}/pull/\\d+$`, 'u').test(url)) {
      throw new Error(
        'GitHub returned no valid created PR URL; reconcile the branch before retrying.'
      );
    }
    output(env, 'url', url);
    save(env, retained, 'pr-created', `Actual PR: ${url}; Linear linking must acknowledge it.`);
  } catch (error) {
    save(
      env,
      retained,
      'publication-blocked',
      `${error.message} Retained patch requires owner action; no issue completion or claim release.`
    );
    throw error;
  }
}
const invoked = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invoked && realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    publication(process.argv[2]);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
