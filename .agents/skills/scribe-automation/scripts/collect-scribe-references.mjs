#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`scribe reference collector: ${message}`);
}

function parseArgs(argv) {
  const options = { docs: 'docs/agents', format: 'summary', repo: process.cwd(), revision: 'HEAD' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      console.log(
        'Usage: node collect-scribe-references.mjs --repo <path> [--revision <git-rev>] [--docs <path>] [--format summary|json|markdown]'
      );
      process.exit(0);
    }
    if (!['--repo', '--revision', '--docs', '--format'].includes(argument)) {
      fail(`unsupported argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!['summary', 'json', 'markdown'].includes(options.format)) {
    fail(`unsupported format ${options.format}`);
  }
  return options;
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function readRevisionFile(repo, revision, path) {
  try {
    return execFileSync('git', ['-C', repo, 'show', `${revision}:${path}`], { encoding: 'utf8' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${path} at ${revision}: ${detail}`);
  }
}

function unique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function location(path, line) {
  return `${path}:${line}`;
}

function parsePackageScripts(repo, revision, allPaths) {
  const packages = new Map();
  for (const path of allPaths.filter(
    (candidate) => candidate === 'package.json' || candidate.endsWith('/package.json')
  )) {
    let packageJson;
    try {
      packageJson = JSON.parse(readRevisionFile(repo, revision, path));
    } catch (error) {
      fail(`cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof packageJson.name === 'string') {
      packages.set(packageJson.name, packageJson);
    }
    if (path === 'package.json') {
      packages.set('__root__', packageJson);
    }
  }
  return packages;
}

function classifyCommand(command, packages, allPaths) {
  const normalized = command.trim();
  const root = packages.get('__root__');
  const pnpmBuiltin = normalized.match(/^pnpm\s+(?:run\s+)?(install|patch)(?:\s|$)/);
  const pnpmExec = normalized.match(/^pnpm\s+exec\s+([^\s]+)/);
  const filtered = normalized.match(/^pnpm\s+--filter\s+([^\s]+)\s+(?:run\s+)?([^\s]+)/);
  // Must start with a letter so `pnpm --version` / `pnpm -r` are not read as
  // a script named "--version".
  const rootScript = normalized.match(/^pnpm\s+(?:run\s+)?([A-Za-z][\w:-]*)/);
  const nodeScript = normalized.match(/^node\s+([^\s]+)/);
  const npxPackage = normalized.match(/^npx\s+([@\w/-]+)/);

  if (pnpmBuiltin) {
    return 'ACCURATE';
  }
  if (/^pnpm\s+(?:-r|--recursive|dlx)\b/.test(normalized)) {
    return 'MANUAL';
  }
  if (pnpmExec) {
    const dependencies = Object.keys({ ...root?.dependencies, ...root?.devDependencies });
    return dependencies.some(
      (dependency) => dependency === pnpmExec[1] || dependency.endsWith(`/${pnpmExec[1]}`)
    )
      ? 'ACCURATE'
      : 'MANUAL';
  }
  if (filtered) {
    const packageJson = packages.get(filtered[1]);
    return packageJson?.scripts?.[filtered[2]] ? 'ACCURATE' : 'DANGLING';
  }
  if (rootScript) {
    const name = rootScript[1];
    if (root?.scripts?.[name]) {
      return 'ACCURATE';
    }
    // A bare `pnpm <bin>` invocation of a dependency binary (e.g.
    // `pnpm vitest run`) is not a package script — never a DANGLING script.
    const dependencies = { ...root?.dependencies, ...root?.devDependencies };
    if (dependencies[name] || Object.keys(dependencies).some((dep) => dep.endsWith(`/${name}`))) {
      return 'MANUAL';
    }
    return 'DANGLING';
  }
  if (nodeScript) {
    return allPaths.has(nodeScript[1]) ? 'ACCURATE' : 'MANUAL';
  }
  if (npxPackage) {
    const dependencies = { ...root?.dependencies, ...root?.devDependencies };
    return dependencies[npxPackage[1]] ? 'ACCURATE' : 'MANUAL';
  }
  return 'MANUAL';
}

function isProjectPath(token) {
  return (
    /^(?:apps|packages|scripts|docs|\.github|\.night-shift)\//.test(token) && !/[{}*]/.test(token)
  );
}

// A backticked token that looks like a repository file but is not under a
// known project directory (root files: AGENTS.md, db-test-lane-manifest.mjs,
// secret-scan.config.json, …). Without this these fell through every branch
// and were invisible. Confidence comes from the EXTENSION, not the name: a
// real file extension (or an explicit relative path) — never a hyphen, which
// appears in plenty of dotted identifiers (`subagent-personas.v1`).
const FILE_TOKEN = /^[\w./-]+\.[A-Za-z0-9]+$/;
const FILE_EXTENSION = /\.(?:md|mjs|cjs|mts|cts|jsonc?|ya?ml|toml|sh)$/i;

function isFileToken(token) {
  if (/[{}*\s]/.test(token) || isProjectPath(token) || !FILE_TOKEN.test(token)) {
    return false;
  }
  // Known non-code file extension, or an explicit relative path with any
  // extension. Bare dotted tokens with code-ish extensions stay symbols.
  return FILE_EXTENSION.test(token) || (token.includes('/') && /\.[A-Za-z0-9]+$/.test(token));
}

// Found → ACCURATE (the mechanical win: previously these were invisible).
// Absent → MANUAL, never DANGLING: docs/agents prose cites filenames as
// examples and contrasts (`knip.json` vs `knip.jsonc`, the `AGENTS.md` →
// `AGENT.md` lookup order), so a missing file token is a human-verify lead,
// not a mechanical certainty. DANGLING stays reserved for the unambiguous
// classes (project paths, migration numbers).
function classifyFileToken(token, allPaths) {
  if (allPaths.has(token)) {
    return 'ACCURATE';
  }
  const base = token.split('/').pop();
  return [...allPaths].some((path) => path.split('/').pop() === base) ? 'ACCURATE' : 'MANUAL';
}

function classifyProjectPath(token, allPaths) {
  if (token.includes('...')) {
    return 'MANUAL';
  }
  const normalized = token.replace(/\/+$/, '');
  if (!normalized) {
    return 'MANUAL';
  }
  return allPaths.has(normalized) || [...allPaths].some((path) => path.startsWith(`${normalized}/`))
    ? 'ACCURATE'
    : 'DANGLING';
}

function isCommand(token) {
  return /^(?:pnpm|node|npx)\s/.test(token.trim());
}

function isSymbol(token) {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(token);
}

function collectDocument(path, text, allPaths, packages) {
  const references = [];
  const migrations = new Set();
  const lines = text.split(/\r?\n/);
  for (let offset = 0; offset < lines.length; offset += 1) {
    const line = lines[offset];
    const lineNumber = offset + 1;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim();
      if (!token) {
        continue;
      }
      if (isProjectPath(token)) {
        references.push({
          kind: 'path',
          location: location(path, lineNumber),
          reference: token,
          status: classifyProjectPath(token, allPaths),
        });
      } else if (isCommand(token)) {
        references.push({
          kind: 'command',
          location: location(path, lineNumber),
          reference: token,
          status: classifyCommand(token, packages, allPaths),
        });
      } else if (isFileToken(token)) {
        references.push({
          kind: 'file',
          location: location(path, lineNumber),
          reference: token,
          status: classifyFileToken(token, allPaths),
        });
      } else if (isSymbol(token)) {
        references.push({
          kind: 'symbol',
          location: location(path, lineNumber),
          reference: token,
          status: 'MANUAL',
        });
      }
    }
    for (const match of line.matchAll(/\bmigration[- ]0*(\d{2,3})\b/gi)) {
      migrations.add(match[1].padStart(3, '0'));
      const prefix = `packages/db/src/migrations/${match[1].padStart(3, '0')}-`;
      const found = [...allPaths].some((candidate) => candidate.startsWith(prefix));
      references.push({
        kind: 'migration',
        location: location(path, lineNumber),
        reference: `migration ${match[1].padStart(3, '0')}`,
        status: found ? 'ACCURATE' : 'DANGLING',
      });
    }
  }
  const pairs = lines.flatMap((line, offset) =>
    /paired tests?/i.test(line)
      ? [...line.matchAll(/`([^`]*\.test\.(?:[cm]?[jt]sx?))`/g)].map((match) => ({
          kind: 'paired-test',
          location: location(path, offset + 1),
          reference: match[1],
          status: allPaths.has(match[1]) ? 'ACCURATE' : 'MANUAL',
        }))
      : []
  );
  references.push(...pairs);
  const summary = references.reduce((counts, reference) => {
    counts[reference.status] = (counts[reference.status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    migrationNumbers: unique([...migrations]),
    path,
    referenceCount: references.length,
    references,
    statusCounts: summary,
  };
}

function markdown(result) {
  const rows = result.documents.map((document) => {
    const unresolved = (document.statusCounts.DANGLING ?? 0) + (document.statusCounts.MANUAL ?? 0);
    const status = document.statusCounts.DANGLING
      ? 'MECHANICAL FINDINGS'
      : unresolved
        ? 'MANUAL REVIEW REQUIRED'
        : 'MECHANICALLY CLEAN';
    return `| ${document.path} | ${document.referenceCount} | ${status} |`;
  });
  return [
    '# Scribe mechanical reference manifest',
    '',
    `Audited revision: \`${result.revision}\`.`,
    '',
    '| Contract | Candidate checks | Mechanical result |',
    '| --- | ---: | --- |',
    ...rows,
    '',
  ].join('\n');
}

export { classifyCommand, classifyFileToken, classifyProjectPath, isFileToken };

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.repo)) {
    fail(`repository does not exist: ${options.repo}`);
  }
  git(options.repo, ['rev-parse', '--is-inside-work-tree']);
  const revision = git(options.repo, ['rev-parse', options.revision]);
  const allPaths = new Set(
    git(options.repo, ['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean)
  );
  const documentPaths = [...allPaths]
    .filter(
      (path) =>
        path.startsWith(`${options.docs}/`) &&
        relative(options.docs, path).split('/').length === 1 &&
        path.endsWith('.md')
    )
    .sort();
  if (!documentPaths.length) {
    fail(`no direct Markdown contracts found in ${options.docs} at ${revision}`);
  }
  const packages = parsePackageScripts(options.repo, revision, [...allPaths]);
  const documents = documentPaths.map((path) =>
    collectDocument(path, readRevisionFile(options.repo, revision, path), allPaths, packages)
  );
  const findings = documents.flatMap((document) =>
    document.references.filter((reference) => reference.status === 'DANGLING')
  );
  const result = { documents, findings, revision };
  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.format === 'markdown') {
    console.log(markdown(result));
  } else {
    console.log(`revision=${revision}`);
    console.log(
      `contracts=${documents.length} candidate_checks=${documents.reduce((total, document) => total + document.referenceCount, 0)} dangling=${findings.length}`
    );
    for (const document of documents) {
      const manual = document.statusCounts.MANUAL ?? 0;
      const dangling = document.statusCounts.DANGLING ?? 0;
      console.log(
        `${document.path}: checks=${document.referenceCount} manual=${manual} dangling=${dangling}`
      );
    }
    for (const finding of findings) {
      console.log(`DANGLING ${finding.kind} ${finding.location} ${finding.reference}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
