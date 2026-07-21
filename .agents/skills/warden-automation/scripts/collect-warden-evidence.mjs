#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const SCRIPT_PATTERN = /\.(?:mjs|cjs)$/;
const TEST_PATTERN = /\.test\.mjs$/;
const NEGATIVE_CONTROL_PATTERN =
  /\b(?:blind spot|crashes?|detects?|drifts?|duplicates?|fails?|flags?|forbids?|invalid|mismatches?|missing|money|must|non-zero|orphans?|outside|rejects?|stale|throws?|unclassified|uncovered|unsafe|vacuous|violations?)\b/i;

function usage() {
  return [
    'Usage: collect-warden-evidence.mjs --repo <path> [--pretty]',
    '',
    'Read-only: prints Warden guard inventory evidence as JSON.',
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

function run(command, args, cwd, { allowFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const stderr = error?.stderr?.toString().trim();
    const detail = stderr ? `\n${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
}

function git(repo, args, options) {
  return run(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    repo,
    options
  );
}

function assertFile(repo, relativePath) {
  const absolutePath = path.join(repo, relativePath);
  if (!(existsSync(absolutePath) && statSync(absolutePath).isFile())) {
    throw new Error(`Required file is missing: ${relativePath}`);
  }
  return absolutePath;
}

function listFiles(directory, predicate) {
  if (!(existsSync(directory) && statSync(directory).isDirectory())) {
    throw new Error(`Required directory is missing: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
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
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function deriveCharter(charterText) {
  const versionMatch = charterText.match(/\bCHARTER_VERSION=(\d+)\b/);
  const stateIssueMatch = charterText.match(/\bSTATE_ISSUE="([^"]+)"/);
  const repairCapMatch = charterText.match(/Cap at (\d+) repairs per\s+PR/i);
  if (!(versionMatch && stateIssueMatch && repairCapMatch)) {
    throw new Error('Could not derive Warden version, state issue, and repair cap from charter');
  }
  if (!/scripts\/\*\.mjs and scripts\/\*\.cjs/.test(charterText)) {
    throw new Error('Warden charter no longer declares the expected root guard-script inventory');
  }
  if (!/scripts\/__tests__\/\*\.test\.mjs/.test(charterText)) {
    throw new Error('Warden charter no longer declares the expected paired-test inventory');
  }
  return {
    repairCap: Number(repairCapMatch[1]),
    stateIssueTitle: stateIssueMatch[1],
    version: Number(versionMatch[1]),
  };
}

function lineReferences(relativePath, text, needles) {
  const references = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (needles.some((needle) => line.includes(needle))) {
      references.push({
        line: index + 1,
        path: relativePath,
        text: line.trim(),
      });
    }
  });
  return references;
}

function extractScriptPaths(text) {
  return uniqueSorted(text.match(/scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs)/g) ?? []);
}

// A commented-out `pnpm test:scripts` or `node scripts/x.mjs` line is not wiring.
// Full-line YAML comments are blanked (not removed) so line numbers stay stable for
// the evidence references built from the same text.
function stripYamlFullLineComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n');
}

function extractLocalSpecifiers(text) {
  const specifiers = [];
  const pattern =
    /(?:import\s+(?:[^'";]*?\s+from\s+)?|export\s+[^'";]*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1].startsWith('.')) {
      specifiers.push(match[1]);
    }
  }
  return uniqueSorted(specifiers);
}

function resolveLocalSpecifier(repo, fromRelativePath, specifier) {
  const base = path.resolve(repo, path.dirname(fromRelativePath), specifier);
  const candidates = [
    base,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.js`,
    path.join(base, 'index.mjs'),
    path.join(base, 'index.cjs'),
  ];
  for (const candidate of candidates) {
    if (!(existsSync(candidate) && statSync(candidate).isFile())) {
      continue;
    }
    const relativePath = path.relative(repo, candidate).split(path.sep).join('/');
    if (relativePath === 'scripts' || relativePath.startsWith('scripts/')) {
      return relativePath;
    }
  }
  return null;
}

function extractTestTitles(text) {
  const titles = [];
  const pattern = /\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])([^\n]*?)\1/g;
  for (const match of text.matchAll(pattern)) {
    const title = match[2].replace(/\\(['"`])/g, '$1').trim();
    if (title) {
      titles.push(title);
    }
  }
  return uniqueSorted(titles);
}

function packageScriptMentioned(text, scriptName) {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.split(/\r?\n/).some((line) => {
    if (!/\bpnpm\b/.test(line)) {
      return false;
    }
    return new RegExp(`(?:^|[\\s'"]){1}${escaped}(?=$|[\\s'";&|])`).test(line);
  });
}

function collectPackageMetadata(repo) {
  const trackedOutput = git(repo, [
    'ls-files',
    '-z',
    '--',
    'package.json',
    ':(glob)**/package.json',
  ]);
  const paths = uniqueSorted(
    trackedOutput
      .split('\0')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (!paths.includes('package.json')) {
    throw new Error('Tracked root package.json is missing');
  }
  return paths.map((relativePath) => {
    const text = readFileSync(assertFile(repo, relativePath), 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch {
      throw new Error(`Malformed JSON: ${relativePath}`);
    }
    return { manifest, path: relativePath, text };
  });
}

function buildImportGraph(repo, sourcePaths) {
  const graph = new Map();
  for (const relativePath of sourcePaths) {
    const text = readFileSync(assertFile(repo, relativePath), 'utf8');
    const targets = extractLocalSpecifiers(text)
      .map((specifier) => resolveLocalSpecifier(repo, relativePath, specifier))
      .filter(Boolean);
    graph.set(relativePath, uniqueSorted(targets));
  }
  return graph;
}

function reachableFrom(graph, entries) {
  const reached = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reached.has(current)) {
      continue;
    }
    reached.add(current);
    for (const target of graph.get(current) ?? []) {
      if (!reached.has(target)) {
        queue.push(target);
      }
    }
  }
  return reached;
}

function collectHistory(repo, relativePath) {
  const output = git(repo, ['log', '-5', '--format=%H%x09%cI%x09%s', '--', relativePath]);
  if (!output) {
    return [];
  }
  return output.split(/\r?\n/).map((line) => {
    const [sha, committedAt, ...subjectParts] = line.split('\t');
    return { committedAt, sha, subject: subjectParts.join('\t') };
  });
}

function collectGuardSignals(relativePath, text) {
  const signals = [];
  if (/(?:guard|contract|verify|check|enforce|scan|forbid)/i.test(path.basename(relativePath))) {
    signals.push('guard-like filename');
  }
  if (/\bGuard\b|guard against|must not|violations?|contract check/i.test(text)) {
    signals.push('guard language in source');
  }
  if (/process\.exit\(\s*1\s*\)|process\.exitCode\s*=\s*1|throw new Error/.test(text)) {
    signals.push('explicit failure path');
  }
  if (/apps\/|packages\/|\.github\/workflows|pnpm-workspace/.test(text)) {
    signals.push('repository-wide protected surface');
  }
  return signals;
}

function collectHeaderComments(text) {
  const comments = [];
  for (const line of text.split(/\r?\n/).slice(0, 50)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) {
      comments.push(trimmed.replace(/^\/\/\s?/, ''));
    }
    if (comments.length === 6) {
      break;
    }
  }
  return comments;
}

function main() {
  const { pretty, repo } = parseArgs(process.argv.slice(2));
  const repositoryRoot = realpathSync(git(repo, ['rev-parse', '--show-toplevel']));
  if (repositoryRoot !== repo) {
    throw new Error(`--repo must be the repository root: ${repositoryRoot}`);
  }

  const charterPath = assertFile(repo, '.night-shift/charters/warden.md');
  assertFile(repo, '.night-shift/PROTOCOL.md');
  assertFile(repo, 'AGENTS.md');
  assertFile(repo, 'docs/agents/ci-quality.md');
  const charter = deriveCharter(readFileSync(charterPath, 'utf8'));

  const scriptNames = listFiles(path.join(repo, 'scripts'), (name) => SCRIPT_PATTERN.test(name));
  const testNames = listFiles(path.join(repo, 'scripts', '__tests__'), (name) =>
    TEST_PATTERN.test(name)
  );
  if (scriptNames.length === 0 || testNames.length === 0) {
    throw new Error('Guard-script or paired-test inventory is empty');
  }

  const scriptPaths = scriptNames.map((name) => `scripts/${name}`);
  const testPaths = testNames.map((name) => `scripts/__tests__/${name}`);
  const sourcePaths = [...scriptPaths, ...testPaths];
  const sourceTexts = new Map(
    sourcePaths.map((relativePath) => [
      relativePath,
      readFileSync(assertFile(repo, relativePath), 'utf8'),
    ])
  );
  const packageMetadata = collectPackageMetadata(repo);
  const rootPackage = packageMetadata.find((entry) => entry.path === 'package.json');
  const rootScripts = rootPackage?.manifest?.scripts;
  if (!rootScripts || typeof rootScripts !== 'object' || Array.isArray(rootScripts)) {
    throw new Error('Root package.json has no scripts object');
  }

  const workflowFiles = listFilesRecursively(path.join(repo, '.github', 'workflows'))
    .filter((absolutePath) => /\.ya?ml$/i.test(absolutePath))
    .map((absolutePath) => path.relative(repo, absolutePath).split(path.sep).join('/'));
  if (workflowFiles.length === 0) {
    throw new Error('No GitHub workflow files were found');
  }
  const workflowTexts = new Map(
    workflowFiles.map((relativePath) => [
      relativePath,
      stripYamlFullLineComments(readFileSync(assertFile(repo, relativePath), 'utf8')),
    ])
  );
  const combinedWorkflowText = [...workflowTexts.values()].join('\n');

  const ciPackageScripts = Object.keys(rootScripts)
    .filter((name) => packageScriptMentioned(combinedWorkflowText, name))
    .sort((left, right) => left.localeCompare(right));
  const reachablePackageScripts = new Set();
  const packageQueue = [...ciPackageScripts];
  while (packageQueue.length > 0) {
    const name = packageQueue.shift();
    if (!name || reachablePackageScripts.has(name)) {
      continue;
    }
    reachablePackageScripts.add(name);
    const command = String(rootScripts[name]);
    for (const candidate of Object.keys(rootScripts)) {
      if (packageScriptMentioned(command, candidate) && !reachablePackageScripts.has(candidate)) {
        packageQueue.push(candidate);
      }
    }
  }

  const ciGuardEntryFiles = new Set();
  const ciTestEntryFiles = new Set();
  for (const text of workflowTexts.values()) {
    for (const scriptPath of extractScriptPaths(text)) {
      if (scriptPaths.includes(scriptPath)) {
        ciGuardEntryFiles.add(scriptPath);
      } else if (testPaths.includes(scriptPath)) {
        ciTestEntryFiles.add(scriptPath);
      }
    }
  }
  for (const scriptName of reachablePackageScripts) {
    const command = String(rootScripts[scriptName]);
    for (const scriptPath of extractScriptPaths(command)) {
      if (scriptPaths.includes(scriptPath)) {
        ciGuardEntryFiles.add(scriptPath);
      } else if (testPaths.includes(scriptPath)) {
        ciTestEntryFiles.add(scriptPath);
      }
    }
    if (/scripts\/__tests__\/\*\.test\.mjs|node\s+--test\s+scripts\/__tests__/.test(command)) {
      for (const testPath of testPaths) {
        ciTestEntryFiles.add(testPath);
      }
    }
  }

  const graph = buildImportGraph(repo, sourcePaths);
  const ciReachableFiles = reachableFrom(graph, ciGuardEntryFiles);
  const testReachability = new Map(
    testPaths.map((testPath) => [testPath, reachableFrom(graph, [testPath])])
  );
  const testTitles = new Map(
    testPaths.map((testPath) => [testPath, extractTestTitles(sourceTexts.get(testPath))])
  );
  const trackedFiles = new Set(
    git(repo, ['ls-files', '-z', '--', 'scripts'])
      .split('\0')
      .map((value) => value.trim())
      .filter(Boolean)
  );

  const inventory = scriptPaths.map((relativePath) => {
    const text = sourceTexts.get(relativePath);
    const directTests = testPaths.filter((testPath) =>
      (graph.get(testPath) ?? []).includes(relativePath)
    );
    const transitiveTests = testPaths.filter(
      (testPath) =>
        testReachability.get(testPath).has(relativePath) && !directTests.includes(testPath)
    );
    const pairedTests = [...directTests, ...transitiveTests];
    const negativeControlCandidates = pairedTests.flatMap((testPath) =>
      testTitles
        .get(testPath)
        .filter((title) => NEGATIVE_CONTROL_PATTERN.test(title))
        .map((title) => ({ test: testPath, title }))
    );
    const packageReferences = packageMetadata.flatMap((entry) =>
      lineReferences(entry.path, entry.text, [relativePath, path.basename(relativePath)])
    );
    const workflowReferences = workflowFiles.flatMap((workflowPath) =>
      lineReferences(workflowPath, workflowTexts.get(workflowPath), [
        relativePath,
        path.basename(relativePath),
      ])
    );
    const signals = collectGuardSignals(relativePath, text);
    // Distinct wiring class: the guard is enforced by a paired scripts/__tests__ test that
    // CI executes (test:scripts). Whether that paired test asserts on the REAL repository
    // tree (WIRED per charter) versus fixtures only remains a manual ARMED-style check.
    const ciReachableTests = directTests.filter((testPath) => ciTestEntryFiles.has(testPath));

    return {
      arming: {
        negativeControlCandidates,
        status: 'manual-review-required',
      },
      candidateHint: signals.length >= 2,
      classification: 'review-required',
      headerComments: collectHeaderComments(text),
      history: collectHistory(repo, relativePath),
      name: path.basename(relativePath),
      pairing: {
        directTests,
        transitiveTests,
      },
      path: relativePath,
      signals,
      tracked: trackedFiles.has(relativePath),
      wiring: {
        ciReachable: ciReachableFiles.has(relativePath),
        ciReachableTests,
        ciTestReachable: ciReachableTests.length > 0,
        packageReferences,
        workflowReferences,
      },
    };
  });

  const originMain = git(repo, ['rev-parse', '--verify', 'refs/remotes/origin/main'], {
    allowFailure: true,
  });
  const head = git(repo, ['rev-parse', 'HEAD']);
  const branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], {
    allowFailure: true,
  });
  const dirtyLines = git(repo, ['status', '--short', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter(Boolean);
  const inventoryExists = existsSync(path.join(repo, 'scripts', '_guard-inventory.md'));
  const preflightBlockers = [];
  if (!originMain) {
    preflightBlockers.push('refs/remotes/origin/main is missing');
  } else if (head !== originMain) {
    preflightBlockers.push('HEAD does not match the local origin/main ref');
  }
  if (dirtyLines.length > 0) {
    preflightBlockers.push('working tree is dirty');
  }
  // A missing guard inventory is not a blocker: only Warden ever creates it (charter
  // Beat 5), so blocking on its absence would deadlock the bootstrap run forever.
  const firstRunEvidence = inventoryExists
    ? []
    : ['scripts/_guard-inventory.md does not exist yet; Warden creates it on the first run'];

  const output = {
    charter,
    ci: {
      guardEntryFiles: uniqueSorted(ciGuardEntryFiles),
      packageScripts: ciPackageScripts,
      reachablePackageScripts: uniqueSorted(reachablePackageScripts),
      testEntryFiles: uniqueSorted(ciTestEntryFiles),
      workflowFiles,
    },
    generatedAt: new Date().toISOString(),
    git: {
      branch: branch || null,
      dirty: dirtyLines,
      head,
      headMatchesOriginMain: originMain ? head === originMain : null,
      originMain: originMain || null,
    },
    inventory: {
      guardInventoryExists: inventoryExists,
      rootScriptCount: inventory.length,
      scripts: inventory,
      testCount: testPaths.length,
      tests: testPaths.map((testPath) => ({
        negativeControlCandidates: testTitles
          .get(testPath)
          .filter((title) => NEGATIVE_CONTROL_PATTERN.test(title)),
        path: testPath,
        titles: testTitles.get(testPath),
      })),
    },
    preflight: {
      blockers: preflightBlockers,
      firstRunEvidence,
      limitations: [
        'origin/main freshness is unverified because the read-only collector does not fetch',
        'guard classification and ARMED status require manual review',
      ],
      status: preflightBlockers.length > 0 ? 'blocked' : 'local-evidence-ready',
    },
    repo,
    status: preflightBlockers.length > 0 ? 'blocked' : 'ok',
    summary: {
      candidateHintCount: inventory.filter((entry) => entry.candidateHint).length,
      ciReachableScriptCount: inventory.filter((entry) => entry.wiring.ciReachable).length,
      ciTestReachableScriptCount: inventory.filter((entry) => entry.wiring.ciTestReachable).length,
      directlyPairedScriptCount: inventory.filter((entry) => entry.pairing.directTests.length > 0)
        .length,
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, pretty ? 2 : 0)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Warden evidence collection failed: ${error.message}\n`);
  process.exit(1);
}
