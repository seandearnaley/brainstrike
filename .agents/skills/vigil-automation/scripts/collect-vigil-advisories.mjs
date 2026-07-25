#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-vigil-advisories';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write('Usage: node collect-vigil-advisories.mjs --repo <path> [--pretty]\n');
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (argument !== '--repo') {
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
    fail(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function git(repo, args) {
  return execute('git', ['-C', repo, ...args], repo);
}

function validateRepo(repoArgument) {
  let repo;
  try {
    repo = realpathSync(resolve(repoArgument));
  } catch (error) {
    fail(`cannot resolve --repo: ${error instanceof Error ? error.message : String(error)}`);
  }
  const topLevel = git(repo, ['rev-parse', '--show-toplevel']).trim();
  let realTopLevel;
  try {
    realTopLevel = realpathSync(topLevel);
  } catch (error) {
    fail(
      `cannot resolve git work-tree root: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (repo !== realTopLevel) {
    fail(`--repo must name the git work-tree root: ${realTopLevel}`);
  }
  if (!existsSync(resolve(repo, '.night-shift/PROTOCOL.md'))) {
    fail(`${repo} does not contain .night-shift/PROTOCOL.md`);
  }
  if (!existsSync(resolve(repo, 'pnpm-lock.yaml'))) {
    fail(`${repo} does not contain pnpm-lock.yaml`);
  }
  return repo;
}

function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `${context} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requireObject(value, context) {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    fail(`${context} must be an object`);
  }
  return value;
}

function requireString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function advisoryId(advisory, context) {
  if (
    typeof advisory.github_advisory_id === 'string' &&
    /^GHSA-[\w-]+$/iu.test(advisory.github_advisory_id)
  ) {
    return advisory.github_advisory_id;
  }
  const url = typeof advisory.url === 'string' ? advisory.url : advisory.github_advisory_url;
  const match = typeof url === 'string' ? /\bGHSA-[\w-]+\b/iu.exec(url) : null;
  if (!match) {
    fail(`${context} lacks a GitHub advisory id`);
  }
  return match[0];
}

function stringArray(value, context) {
  if (!(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))) {
    fail(`${context} must be an array of strings`);
  }
  return [...new Set(value)].sort();
}

function normalizePnpmAudit(raw) {
  const audit = requireObject(parseJson(raw, 'pnpm audit'), 'pnpm audit result');
  const advisories = requireObject(audit.advisories ?? {}, 'pnpm audit advisories');
  return Object.entries(advisories).map(([key, value]) => {
    const advisory = requireObject(value, `pnpm audit advisory ${key}`);
    const findings = Array.isArray(advisory.findings)
      ? advisory.findings
      : fail(`pnpm audit advisory ${key}.findings must be an array`);
    const installedVersions = [];
    const paths = [];
    for (const [index, findingValue] of findings.entries()) {
      const finding = requireObject(findingValue, `pnpm audit advisory ${key}.findings[${index}]`);
      installedVersions.push(
        requireString(finding.version, `pnpm audit advisory ${key}.findings[${index}].version`)
      );
      paths.push(
        ...stringArray(finding.paths, `pnpm audit advisory ${key}.findings[${index}].paths`)
      );
    }
    return {
      dev: null,
      id: advisoryId(advisory, `pnpm audit advisory ${key}`),
      installedVersions: [...new Set(installedVersions)].sort(),
      package: requireString(advisory.module_name, `pnpm audit advisory ${key}.module_name`),
      // An unpatched advisory legitimately has no patched range — those are
      // the ones Vigil most needs to route, so absence must not block the
      // run (Dependabot-only advisories already carry null here). A present
      // non-string value is still malformed input.
      patchedRange:
        advisory.patched_versions === undefined ||
        advisory.patched_versions === null ||
        advisory.patched_versions === '<0.0.0'
          ? null
          : requireString(advisory.patched_versions, `pnpm audit advisory ${key}.patched_versions`),
      paths: [...new Set(paths)].sort(),
      severity: requireString(advisory.severity, `pnpm audit advisory ${key}.severity`),
      vulnerableRange: requireString(
        advisory.vulnerable_versions,
        `pnpm audit advisory ${key}.vulnerable_versions`
      ),
    };
  });
}

function collectPnpmAudit(repo) {
  try {
    return normalizePnpmAudit(
      execFileSync('pnpm', ['audit', '--json'], {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  } catch (error) {
    const stdout =
      error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : '';
    try {
      return normalizePnpmAudit(stdout);
    } catch {
      const stderr =
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
      fail(`pnpm audit --json failed without parseable JSON${stderr ? `: ${stderr}` : ''}`);
    }
  }
}

function collectDependabot(repo) {
  const repository = requireObject(
    parseJson(execute('gh', ['repo', 'view', '--json', 'nameWithOwner'], repo), 'gh repo view'),
    'gh repo view result'
  );
  const nameWithOwner = requireString(repository.nameWithOwner, 'gh repo view nameWithOwner');
  const pages = parseJson(
    execute(
      'gh',
      ['api', '--paginate', '--slurp', `repos/${nameWithOwner}/dependabot/alerts`],
      repo
    ),
    'gh dependabot alerts'
  );
  if (!(Array.isArray(pages) && pages.every(Array.isArray))) {
    fail('gh dependabot alerts result must be an array of pages');
  }
  return pages
    .flat()
    .filter((alert) => {
      const item = requireObject(alert, 'Dependabot alert');
      return requireString(item.state, 'Dependabot alert state') === 'open';
    })
    .map((alert, index) => {
      const item = requireObject(alert, `Dependabot alert ${index}`);
      const dependency = requireObject(item.dependency, `Dependabot alert ${index}.dependency`);
      const dependencyPackage = requireObject(
        dependency.package,
        `Dependabot alert ${index}.dependency.package`
      );
      const security = requireObject(
        item.security_advisory,
        `Dependabot alert ${index}.security_advisory`
      );
      return {
        ghsaId: requireString(
          security.ghsa_id,
          `Dependabot alert ${index}.security_advisory.ghsa_id`
        ),
        manifestPath: requireString(
          dependency.manifest_path,
          `Dependabot alert ${index}.dependency.manifest_path`
        ),
        package: requireString(
          dependencyPackage.name,
          `Dependabot alert ${index}.dependency.package.name`
        ),
        severity: requireString(
          security.severity,
          `Dependabot alert ${index}.security_advisory.severity`
        ),
        state: requireString(item.state, `Dependabot alert ${index}.state`),
      };
    });
}

function hashWatchedSet(advisories) {
  const input =
    advisories.length === 0
      ? 'empty'
      : advisories
          .map(
            (advisory) =>
              `${advisory.id}\t${advisory.package}\t${advisory.installedVersions.join(',')}`
          )
          .sort()
          .join('\n');
  return createHash('sha256').update(input).digest('hex');
}

function mergeAdvisories(pnpmAdvisories, dependabotAdvisories) {
  const byKey = new Map();
  for (const advisory of pnpmAdvisories) {
    byKey.set(`${advisory.id}\0${advisory.package}`, { ...advisory, sources: ['pnpm-audit'] });
  }
  for (const alert of dependabotAdvisories) {
    const key = `${alert.ghsaId}\0${alert.package}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.sources.push('dependabot');
      continue;
    }
    byKey.set(key, {
      dev: null,
      id: alert.ghsaId,
      installedVersions: [],
      package: alert.package,
      patchedRange: null,
      paths: [alert.manifestPath],
      severity: alert.severity,
      sources: ['dependabot'],
      vulnerableRange: null,
    });
  }
  return [...byKey.values()]
    .map((advisory) => ({
      ...advisory,
      // Tickets are filed per PACKAGE (charter Beat 3); the legacy per-advisory
      // fingerprint is kept so the sweep can find and fold pre-rule tickets.
      fingerprint: `vigil:advisory:${advisory.package}`,
      legacyFingerprint: `vigil:advisory:${advisory.id}:${advisory.package}`,
      sources: [...new Set(advisory.sources)].sort(),
    }))
    .sort(
      (left, right) => left.id.localeCompare(right.id) || left.package.localeCompare(right.package)
    );
}

function collect(options) {
  const repo = validateRepo(options.repo);
  // pnpm audit reads the WORKING-TREE lockfile — so report the commit that
  // working tree is actually at, and refuse a dirty lockfile. Claiming any
  // other revision here would stamp the output with a lockfile it never
  // audited (silent divergence; forbidden).
  const lockfileStatus = git(repo, ['status', '--porcelain', '--', 'pnpm-lock.yaml']).trim();
  if (lockfileStatus !== '') {
    fail('pnpm-lock.yaml has uncommitted changes; the audited surface would be unprovable');
  }
  const auditedCommit = git(repo, ['rev-parse', 'HEAD']).trim();
  const pnpmAdvisories = collectPnpmAudit(repo);
  const dependabotAdvisories = collectDependabot(repo);
  const advisories = mergeAdvisories(pnpmAdvisories, dependabotAdvisories);
  return {
    advisories,
    auditedCommit,
    counts: {
      dependabot: dependabotAdvisories.length,
      merged: advisories.length,
      pnpmAudit: pnpmAdvisories.length,
    },
    generatedAt: new Date().toISOString(),
    schema: 'collect-vigil-advisories/v1',
    watchedSetHash: hashWatchedSet(advisories),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(collect(options), null, options.pretty ? 2 : 0)}\n`);
}

main();
