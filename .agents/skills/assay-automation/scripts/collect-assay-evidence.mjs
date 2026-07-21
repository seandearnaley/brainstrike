#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path, { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 100 * 1024 * 1024;

function usage() {
  return [
    'Usage: collect-assay-evidence.mjs --repo <path> [--pretty]',
    '',
    'Read-only: prints Assay preflight and PR evidence as JSON.',
  ].join('\n');
}

function parseArgs(argv) {
  let repo = process.cwd();
  let pretty = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo requires a path');
      }
      repo = value;
      index += 1;
      continue;
    }
    if (argument === '--pretty') {
      pretty = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }

  return { pretty, repo: realpathSync(repo) };
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr ? `\n${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
}

function runJson(command, args, cwd) {
  const output = run(command, args, cwd);
  if (!output) {
    throw new Error(`${command} ${args.join(' ')} returned empty JSON`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} ${args.join(' ')} returned malformed JSON`);
  }
}

function assertFile(repo, relativePath) {
  const absolutePath = path.join(repo, relativePath);
  if (!(existsSync(absolutePath) && statSync(absolutePath).isFile())) {
    throw new Error(`Required file is missing: ${relativePath}`);
  }
  return absolutePath;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function deriveCharter(charterText) {
  const versionMatch = charterText.match(/\bCHARTER_VERSION=(\d+)\b/);
  if (!versionMatch) {
    throw new Error('Could not derive CHARTER_VERSION from Assay charter');
  }

  // Beat 1 must be at line start so a prose mention of "Beat 1" inside
  // Beat 0 cannot truncate the allowlist mid-list.
  const beatZeroMatch = charterText.match(/^Beat 0\b([\s\S]*?)^Beat 1\b/m);
  if (!beatZeroMatch) {
    throw new Error('Could not isolate Beat 0 label allowlist');
  }
  const allowedLabels = uniqueSorted(beatZeroMatch[1].match(/review\/[a-z0-9-]+/g) ?? []);
  const riskLabels = allowedLabels.filter((label) => label.startsWith('review/risk-'));
  const factorLabels = allowedLabels.filter((label) => !label.startsWith('review/risk-'));
  if (riskLabels.length === 0 || factorLabels.length === 0) {
    throw new Error('Derived Assay label allowlist is incomplete');
  }

  const stateIssueMatch = charterText.match(/\bSTATE_ISSUE="([^"]+)"/);
  const digestTitleMatch = charterText.match(/Linear issue "(\[review-queue\][^"]+)"/);
  if (!(stateIssueMatch && digestTitleMatch)) {
    throw new Error('Could not derive Assay Linear issue titles');
  }

  return {
    allowedLabels,
    digestIssueTitle: digestTitleMatch[1].replace(/\s+/g, ' ').trim(),
    factorLabels,
    riskLabels,
    stateIssueTitle: stateIssueMatch[1],
    version: Number(versionMatch[1]),
  };
}

function derivePinGuidance(repo) {
  const guidance = [];
  for (const relativePath of ['docs/agents/ci-quality.md', 'docs/agents/database.md']) {
    const lines = readFileSync(assertFile(repo, relativePath), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/\bpinn?ed?\b|do not bump|compatible package family/i.test(line)) {
        guidance.push({
          line: index + 1,
          path: relativePath,
          text: line.trim(),
        });
      }
    });
  }
  if (guidance.length === 0) {
    throw new Error(
      'Derived no pin guidance from ci-quality.md/database.md; the touches-pins factor would silently lose its evidence feed'
    );
  }
  return guidance;
}

function listFilesRecursively(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

// This scan is a tripwire, not a proof: it catches literal `review/`
// mentions and label-event-driven automation, but a workflow could still
// consume labels through indirection it cannot see (repo variables,
// scripts). Violations stop the run; labelSensitive entries are advisory
// evidence for the agent to inspect.
export function scanAutomationForReviewLabels(repo) {
  const violations = [];
  const labelSensitive = [];
  const roots = [path.join(repo, '.github', 'workflows'), path.join(repo, '.github', 'actions')];
  for (const root of roots) {
    for (const absolutePath of listFilesRecursively(root)) {
      if (!/\.ya?ml$/i.test(absolutePath)) {
        continue;
      }
      const relativePath = path.relative(repo, absolutePath);
      const content = readFileSync(absolutePath, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.includes('review/')) {
          violations.push({
            line: index + 1,
            path: relativePath,
            text: line.trim(),
          });
        }
      });
      if (
        /\btypes:[^\n]*\b(?:un)?labeled\b/.test(content) ||
        /github\.event\.label\b/.test(content) ||
        /github\.event\.pull_request\.labels\b/.test(content)
      ) {
        labelSensitive.push({
          path: relativePath,
          reason: 'reacts to label events or reads label names via expressions',
        });
      }
    }
  }
  return { labelSensitive, violations };
}

function flattenPaginated(value, endpoint) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${endpoint} did not return paginated arrays`);
  }
  return value.flat();
}

function apiAllPages(repo, endpoint) {
  const separator = endpoint.includes('?') ? '&' : '?';
  return flattenPaginated(
    runJson('gh', ['api', '--paginate', '--slurp', `${endpoint}${separator}per_page=100`], repo),
    endpoint
  );
}

function normalizeOpenPullRequest(value) {
  if (
    typeof value?.number !== 'number' ||
    typeof value?.title !== 'string' ||
    typeof value?.draft !== 'boolean' ||
    typeof value?.head?.sha !== 'string' ||
    typeof value?.head?.ref !== 'string' ||
    typeof value?.html_url !== 'string'
  ) {
    throw new Error('GitHub returned an incomplete open pull request record');
  }
  return {
    author: {
      is_bot: value.user?.type === 'Bot',
      login: value.user?.login ?? null,
    },
    createdAt: value.created_at,
    headRefName: value.head.ref,
    headRefOid: value.head.sha,
    isDraft: value.draft,
    labels: (value.labels ?? []).map((label) => ({ name: label.name })),
    number: value.number,
    title: value.title,
    updatedAt: value.updated_at,
    url: value.html_url,
  };
}

function normalizeCheck(check) {
  if (check.__typename === 'CheckRun') {
    return {
      conclusion: check.conclusion ?? null,
      detailsUrl: check.detailsUrl ?? null,
      name: check.name,
      status: check.status,
      workflow: check.workflowName ?? null,
    };
  }
  return {
    conclusion: check.state ?? null,
    detailsUrl: check.targetUrl ?? null,
    name: check.context,
    status: check.state,
    workflow: null,
  };
}

function isTestPath(filename) {
  return /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(filename);
}

function isLockfile(filename) {
  return /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/i.test(filename);
}

function isGeneratedCandidate(filename) {
  return /(^|\/)(__generated__|generated|dist|build)(\/|$)|\.generated\./i.test(filename);
}

function collectPatchSignals(patchText) {
  const signals = {
    addedNetworkOrIpc: [],
    addedRetriesOrSkips: [],
    addedTimeoutsOrThresholds: [],
    removedAssertions: [],
    removedExports: [],
  };

  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    const content = line.slice(1).trim();
    if (
      line.startsWith('+') &&
      /\b(fetch|WebSocket|ipcRenderer|ipcMain|invoke|send)\b/.test(content)
    ) {
      signals.addedNetworkOrIpc.push(content);
    }
    if (line.startsWith('+') && /\b(test|it|describe)\.skip\b|\bretr(?:y|ies)\b/i.test(content)) {
      signals.addedRetriesOrSkips.push(content);
    }
    if (line.startsWith('+') && /\b(timeout|threshold)\b/i.test(content)) {
      signals.addedTimeoutsOrThresholds.push(content);
    }
    if (line.startsWith('-') && /\b(expect|assert|toEqual|toBe|toMatch|toThrow)\b/.test(content)) {
      signals.removedAssertions.push(content);
    }
    if (line.startsWith('-') && /^export\b/.test(content)) {
      signals.removedExports.push(content);
    }
  }

  for (const key of Object.keys(signals)) {
    signals[key] = uniqueSorted(signals[key]).slice(0, 30);
  }
  return signals;
}

function collectFactorCandidates(pr, files, patchText) {
  const filenames = files.map((file) => file.filename);
  const testFiles = filenames.filter(isTestPath);
  const lockfiles = filenames.filter(isLockfile);
  const generatedCandidates = filenames.filter(isGeneratedCandidate);
  const excluded = new Set([...lockfiles, ...generatedCandidates]);
  const assessedLines = files
    .filter((file) => !excluded.has(file.filename))
    .reduce((total, file) => total + file.additions + file.deletions, 0);

  return {
    autogen:
      pr.headRefName.startsWith('night-shift/') ||
      pr.author?.is_bot === true ||
      pr.author?.login?.endsWith('[bot]') === true,
    generatedCandidates,
    largeDiff: {
      assessedLines,
      candidate: assessedLines > 400,
      note: 'Verify generated-file classification manually before applying the factor.',
    },
    latencyPaths: filenames.filter((filename) =>
      /file-explorer|workspace-search|packages\/db\/src\/.*repositor/i.test(filename)
    ),
    lockfiles,
    noTests: {
      candidate: testFiles.length === 0,
      note: 'Apply only after confirming the diff changes behavior.',
    },
    packageDependencyPaths: filenames.filter((filename) =>
      /(^|\/)(package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/.test(filename)
    ),
    patchSignals: collectPatchSignals(patchText),
    publicApiPaths: filenames.filter((filename) =>
      /^packages\/[^/]+\/(src\/)?index\.[cm]?[jt]sx?$/.test(filename)
    ),
    testFiles,
    touchesCiPaths: filenames.filter(
      (filename) =>
        filename.startsWith('.github/workflows/') ||
        /(^|\/)(action\.ya?ml|turbo\.json)$/.test(filename) ||
        /admission|concurrenc|runner|cache/i.test(filename)
    ),
    touchesGuardPaths: filenames.filter(
      (filename) => /^scripts\/.*\.mjs$/.test(filename) || /^scripts\/__tests__\//.test(filename)
    ),
    touchesSchemaPaths: filenames.filter(
      (filename) =>
        filename.startsWith('packages/db/src/migrations/') ||
        /(^|\/)drizzle(?:\/|\.|-)/i.test(filename)
    ),
  };
}

export function extractAssayComments(comments, charter, workKey) {
  // Anchored to line start: a human quote-reply ("> <!-- assay:... -->")
  // must never parse as a brief, or one such comment would put this PR
  // into permanent cache-invalid re-grade churn.
  const markerPattern = /^[ \t]*<!--\s*assay:v(\d+)\s+(assay:[^\s]+)\s*-->/m;
  const allowed = new Set(charter.allowedLabels);
  const assayComments = comments
    .map((comment) => {
      const marker = comment.body.match(markerPattern);
      if (!marker) {
        return null;
      }
      // Cache integrity is verified against the brief's explicit
      // `Labels:` line only — prose in the brief legitimately mentions
      // labels that are not applied (dropped factors, considered floors).
      // A brief without a Labels: line cannot assert anything: null, so
      // the cache never validates against it.
      const labelsLine = comment.body.match(/^Labels:\s*(.*)$/m);
      const assertedLabels = labelsLine
        ? uniqueSorted(
            (labelsLine[1].match(/review\/[a-z0-9-]+/g) ?? []).filter((label) =>
              allowed.has(label)
            )
          )
        : null;
      return {
        assertedLabels,
        author: comment.user?.login ?? null,
        body: comment.body,
        createdAt: comment.created_at,
        id: comment.id,
        markerVersion: Number(marker[1]),
        markerWorkKey: marker[2],
        url: comment.html_url,
      };
    })
    .filter(Boolean);

  const matching = assayComments.filter((comment) => comment.markerWorkKey === workKey);
  return { assayComments, matching };
}

function collectPrEvidence(repo, repositoryName, pr, charter) {
  const detailEndpoint = `repos/${repositoryName}/pulls/${pr.number}`;
  const details = runJson('gh', ['api', detailEndpoint], repo);
  if (
    details.state !== 'open' ||
    details.draft !== pr.isDraft ||
    details.head?.sha !== pr.headRefOid
  ) {
    throw new Error(`PR #${pr.number} state or head moved during enumeration; rerun collection`);
  }
  if (typeof details.changed_files !== 'number') {
    throw new Error(`PR #${pr.number} did not report changed_files`);
  }
  const files = apiAllPages(repo, `repos/${repositoryName}/pulls/${pr.number}/files`);
  if (files.length !== details.changed_files) {
    throw new Error(
      `PR #${pr.number} file enumeration mismatch: expected ${details.changed_files}, received ${files.length}`
    );
  }
  const patchText = run('gh', ['pr', 'diff', String(pr.number), '--patch'], repo);
  const statusCheckRollup = runJson(
    'gh',
    ['pr', 'view', String(pr.number), '--json', 'statusCheckRollup'],
    repo
  ).statusCheckRollup;
  if (!Array.isArray(statusCheckRollup)) {
    throw new Error(`PR #${pr.number} did not report statusCheckRollup`);
  }
  const comments = apiAllPages(repo, `repos/${repositoryName}/issues/${pr.number}/comments`);
  const finalDetails = runJson('gh', ['api', detailEndpoint], repo);
  if (
    finalDetails.state !== 'open' ||
    finalDetails.draft !== pr.isDraft ||
    finalDetails.head?.sha !== pr.headRefOid
  ) {
    throw new Error(`PR #${pr.number} state or head moved during collection; rerun collection`);
  }
  const workKey = `assay:${pr.number}:${pr.headRefOid}:${charter.version}`;
  const currentLabelObjects = finalDetails.labels ?? [];
  const reviewLabels = uniqueSorted(
    currentLabelObjects.map((label) => label.name).filter((label) => label.startsWith('review/'))
  );
  const { assayComments, matching } = extractAssayComments(comments, charter, workKey);
  const cacheComment = matching.length === 1 ? matching[0] : null;
  const labelsMatch =
    cacheComment !== null &&
    cacheComment.assertedLabels !== null &&
    JSON.stringify(cacheComment.assertedLabels) === JSON.stringify(reviewLabels);

  const { labels: _enumeratedLabels, ...prSummary } = pr;

  return {
    ...prSummary,
    additions: details.additions,
    allLabels: uniqueSorted(currentLabelObjects.map((label) => label.name)),
    assayComments,
    cache: {
      labelsMatch,
      matchingCommentCount: matching.length,
      valid: matching.length === 1 && labelsMatch,
    },
    changedFiles: details.changed_files,
    checks: statusCheckRollup.map(normalizeCheck),
    deletions: details.deletions,
    factorCandidates: collectFactorCandidates(pr, files, patchText),
    files: files.map((file) => ({
      additions: file.additions,
      changes: file.changes,
      deletions: file.deletions,
      path: file.filename,
      status: file.status,
    })),
    reviewLabels,
    workKey,
  };
}

function main() {
  const { pretty, repo } = parseArgs(process.argv.slice(2));
  const charterPath = assertFile(repo, '.night-shift/charters/assay.md');
  assertFile(repo, '.night-shift/PROTOCOL.md');
  assertFile(repo, 'docs/agents/ci-quality.md');
  assertFile(repo, 'docs/agents/database.md');

  const charter = deriveCharter(readFileSync(charterPath, 'utf8'));
  const { labelSensitive, violations: workflowViolations } = scanAutomationForReviewLabels(repo);
  const base = {
    charter,
    generatedAt: new Date().toISOString(),
    labelSensitiveAutomation: labelSensitive,
    pinGuidance: derivePinGuidance(repo),
    repo,
    workflowViolations,
  };

  if (workflowViolations.length > 0) {
    process.stdout.write(
      `${JSON.stringify({ ...base, status: 'contract-violation' }, null, pretty ? 2 : 0)}\n`
    );
    process.exit(2);
  }

  run('gh', ['auth', 'status'], repo);
  const repositoryName = run(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    repo
  );
  if (!repositoryName.includes('/')) {
    throw new Error(`Could not prove GitHub repository identity: ${repositoryName}`);
  }
  const actor = run('gh', ['api', 'user', '--jq', '.login'], repo);
  const repositoryLabels = apiAllPages(repo, `repos/${repositoryName}/labels`).map(
    (label) => label.name
  );
  const repositoryReviewLabels = uniqueSorted(
    repositoryLabels.filter((label) => label.startsWith('review/'))
  );
  const allowedSet = new Set(charter.allowedLabels);

  const openPrs = apiAllPages(repo, `repos/${repositoryName}/pulls?state=open`).map(
    normalizeOpenPullRequest
  );
  const drafts = openPrs
    .filter((pr) => pr.isDraft)
    .map((pr) => ({
      headRefOid: pr.headRefOid,
      number: pr.number,
      title: pr.title,
      url: pr.url,
    }));
  const eligible = openPrs
    .filter((pr) => !pr.isDraft)
    .map((pr) => collectPrEvidence(repo, repositoryName, pr, charter));

  const output = {
    ...base,
    actor,
    drafts,
    eligible,
    labels: {
      missing: charter.allowedLabels.filter((label) => !repositoryReviewLabels.includes(label)),
      repositoryReviewLabels,
      unexpected: repositoryReviewLabels.filter((label) => !allowedSet.has(label)),
    },
    repository: repositoryName,
    status: 'ok',
    watermark: eligible.map((pr) => ({
      headRefOid: pr.headRefOid,
      number: pr.number,
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Assay evidence collection failed: ${error.message}\n`);
    process.exit(1);
  }
}
