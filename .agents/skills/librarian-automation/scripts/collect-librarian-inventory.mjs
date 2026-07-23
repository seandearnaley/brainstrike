#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-librarian-inventory';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CHARTERS_ROOT = '.night-shift/charters';
const BULLETIN_PATH = '.night-shift/bulletin.md';

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { pretty: false, revision: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node collect-librarian-inventory.mjs --repo <path> [--revision <revision>] [--pretty]\n'
      );
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (!['--repo', '--revision'].includes(argument)) {
      fail(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.repo) {
    fail('--repo is required');
  }
  return options;
}

function execute(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function validateRepo(repoArgument) {
  let repo;
  try {
    repo = realpathSync(resolve(repoArgument));
  } catch (error) {
    fail(
      `cannot resolve --repo ${repoArgument}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const topLevel = execute('git', ['-C', repo, 'rev-parse', '--show-toplevel'], repo).trim();
  let realTopLevel;
  try {
    realTopLevel = realpathSync(topLevel);
  } catch (error) {
    fail(
      `cannot resolve git work-tree root ${topLevel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (realTopLevel !== repo) {
    fail(`--repo must name the git work-tree root: ${realTopLevel}`);
  }
  if (!existsSync(resolve(repo, '.night-shift/PROTOCOL.md'))) {
    fail(`${repo} does not contain .night-shift/PROTOCOL.md`);
  }
  return repo;
}

function git(repo, args) {
  return execute('git', ['-C', repo, ...args], repo);
}

function revisionPaths(repo, revision, root) {
  const output = git(repo, ['ls-tree', '-r', '--name-only', revision, '--', root]).trim();
  return output ? output.split(/\r?\n/u) : [];
}

function readRevisionFile(repo, revision, file) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${revision}:${file}`], {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    fail(`cannot read ${file} at ${revision}: ${detail}`);
  }
}

function unquoteMetaValue(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const closingQuote = value.indexOf('"', 1);
    if (closingQuote === -1) {
      fail(`unterminated quoted meta value: ${value}`);
    }
    return value.slice(1, closingQuote);
  }
  if (value.startsWith("'")) {
    const closingQuote = value.indexOf("'", 1);
    if (closingQuote === -1) {
      fail(`unterminated quoted meta value: ${value}`);
    }
    return value.slice(1, closingQuote);
  }
  return value.replace(/\s+#.*$/u, '').trim();
}

function parseCharterMeta(file, text) {
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)];
  const meta = {};
  for (const block of blocks) {
    for (const line of block[1].split(/\r?\n/u)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim());
      if (match) {
        meta[match[1]] = unquoteMetaValue(match[2]);
      }
    }
    if (meta.NAME) {
      break;
    }
  }
  if (!meta.NAME) {
    fail(`${file} charter meta block lacks NAME`);
  }
  return {
    learningsFile: meta.LEARNINGS_FILE || null,
    name: meta.NAME,
    schedule: meta.SCHEDULE || null,
  };
}

function collectSmellCandidates(repo, revision, learningsFiles) {
  const candidates = [];
  for (const file of learningsFiles) {
    const lines = readRevisionFile(repo, revision, file).split(/\r?\n/u);
    const firstHeadingIndex = lines.findIndex((line) => /^\s*#{1,6}\s+\S/u.test(line));
    lines.forEach((line, index) => {
      const excerpt = line.trim();
      if (index !== firstHeadingIndex && /\d{4}-\d{2}-\d{2}/u.test(line)) {
        candidates.push({
          excerpt,
          file,
          kind: 'timestamp-content',
          line: index + 1,
        });
      }
      if (/^\s*-\s+(?:ran|run)\s+/iu.test(line)) {
        candidates.push({
          excerpt,
          file,
          kind: 'run-log',
          line: index + 1,
        });
      }
    });
  }
  return candidates.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind)
  );
}

function collect(options) {
  const repo = validateRepo(options.repo);
  const charterFiles = revisionPaths(repo, options.revision, CHARTERS_ROOT)
    .filter(
      (file) =>
        new RegExp(`^${CHARTERS_ROOT}/[^/]+\\.md$`, 'u').test(file) &&
        file !== `${CHARTERS_ROOT}/README.md`
    )
    .sort();
  if (charterFiles.length === 0) {
    fail(`no charter files found at ${options.revision}`);
  }

  const nightShiftPaths = revisionPaths(repo, options.revision, '.night-shift');
  const learningsFiles = nightShiftPaths
    .filter(
      (file) =>
        /^\.night-shift\/[^/]+\.md$/u.test(file) &&
        !['.night-shift/PROTOCOL.md', BULLETIN_PATH].includes(file)
    )
    .sort();
  if (learningsFiles.length === 0) {
    fail(`no learnings files found at ${options.revision}`);
  }
  const learningsSet = new Set(learningsFiles);

  const charters = charterFiles
    .map((file) => {
      const meta = parseCharterMeta(file, readRevisionFile(repo, options.revision, file));
      return {
        file,
        learningsFile: meta.learningsFile,
        learningsFileExists:
          meta.learningsFile === null ? false : learningsSet.has(meta.learningsFile),
        name: meta.name,
      };
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.file.localeCompare(right.file)
    );

  const declaredLearningsFiles = new Set(
    charters.map((charter) => charter.learningsFile).filter((file) => file !== null)
  );
  const orphanLearningsFiles = learningsFiles.filter((file) => !declaredLearningsFiles.has(file));

  const bulletinText = readRevisionFile(repo, options.revision, BULLETIN_PATH);
  const capMatch = /Hard cap\s+(\d+)\s+entry lines/iu.exec(bulletinText);
  if (!capMatch) {
    fail(`${BULLETIN_PATH} lacks the "Hard cap N entry lines" declaration`);
  }
  const cap = Number.parseInt(capMatch[1], 10);
  if (!Number.isSafeInteger(cap) || cap < 1) {
    fail(`${BULLETIN_PATH} declares an invalid hard cap: ${capMatch[1]}`);
  }
  const entryCount = bulletinText
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('- [from:')).length;

  return {
    bulletin: {
      cap,
      entryCount,
      overCap: entryCount > cap,
      sha256: createHash('sha256').update(bulletinText).digest('hex'),
    },
    charters,
    generatedAt: new Date().toISOString(),
    orphanLearningsFiles,
    schema: SCRIPT_NAME,
    smellCandidates: collectSmellCandidates(repo, options.revision, learningsFiles),
  };
}

const options = parseArgs(process.argv.slice(2));
const output = collect(options);
process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
