#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-curator-evidence';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MIGRATIONS_ROOT = 'packages/db/src/migrations';
const PROVIDER_REGISTRY_PATH = 'packages/assistant-contract/src/provider-registry.ts';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

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
        'Usage: node collect-curator-evidence.mjs --repo <path> [--revision <revision>] [--providers-json <file>] [--pretty]\n'
      );
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (!['--repo', '--revision', '--providers-json'].includes(argument)) {
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

// Split SQL text on statement-terminating semicolons only: a `;` inside a
// single-quoted literal (with `''` as the escape) is content, not a
// terminator. A naive split(';') would sever an INSERT mid-VALUES the day a
// free-text column (name/tagline/best_for) contains a semicolon, silently
// dropping every row after the split — the exact under-count this collector
// exists to prevent.
function splitSqlStatements(text) {
  const statements = [];
  let current = '';
  let inQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") {
      if (inQuote && text[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inQuote = !inQuote;
      current += character;
      continue;
    }
    if (character === ';' && !inQuote) {
      statements.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  statements.push(current);
  return statements;
}

function extractMigrationPairs(repo, revision) {
  const migrationFiles = revisionPaths(repo, revision, MIGRATIONS_ROOT)
    .filter((file) => /^packages\/db\/src\/migrations\/[^/]+\.ts$/u.test(file))
    .sort();
  if (migrationFiles.length === 0) {
    fail(`no migration files found at ${revision}`);
  }
  const pairs = [];
  for (const file of migrationFiles) {
    const text = readRevisionFile(repo, revision, file);
    const statements = splitSqlStatements(text);
    for (const statement of statements) {
      if (!/\bINSERT\s+INTO\s+models\b/iu.test(statement)) {
        continue;
      }
      const statementPairs = [...statement.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'/gu)];
      if (statementPairs.length === 0) {
        fail(`${file} contains an INSERT INTO models statement with no extractable tuples`);
      }
      for (const match of statementPairs) {
        pairs.push({ file, modelId: match[1], providerId: match[2] });
      }
    }
  }
  if (pairs.length === 0) {
    fail('model migration extraction yielded zero (model_id, provider_id) pairs');
  }
  return pairs;
}

function buildRepoSurface(repo, revision) {
  const byPair = new Map();
  for (const pair of extractMigrationPairs(repo, revision)) {
    const key = `${pair.modelId}\0${pair.providerId}`;
    const existing = byPair.get(key);
    const entry = existing ?? {
      modelId: pair.modelId,
      providerId: pair.providerId,
      sources: new Set(),
    };
    entry.sources.add(pair.file);
    byPair.set(key, entry);
  }

  const registryText = readRevisionFile(repo, revision, PROVIDER_REGISTRY_PATH);
  const registryIds = new Set();
  for (const match of registryText.matchAll(/(['"])([^'"\r\n]+)\1/gu)) {
    if (/^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/u.test(match[2])) {
      registryIds.add(match[2]);
    }
  }
  for (const modelId of registryIds) {
    const matchingEntries = [...byPair.values()].filter((entry) => entry.modelId === modelId);
    if (matchingEntries.length > 0) {
      for (const entry of matchingEntries) {
        entry.sources.add(PROVIDER_REGISTRY_PATH);
      }
      continue;
    }
    byPair.set(`${modelId}\0`, {
      modelId,
      providerId: null,
      sources: new Set([PROVIDER_REGISTRY_PATH]),
    });
  }

  return [...byPair.values()]
    .map((entry) => ({
      modelId: entry.modelId,
      providerId: entry.providerId,
      sources: [...entry.sources].sort(),
    }))
    .sort(
      (left, right) =>
        left.modelId.localeCompare(right.modelId) ||
        String(left.providerId).localeCompare(String(right.providerId))
    );
}

function parseProviderPayload(payload, source) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    fail(`${source} must contain a data array`);
  }
  if (payload.data.length === 0) {
    fail(`${source} contains an empty data array`);
  }
  const seenIds = new Set();
  const normalized = payload.data.map((model, index) => {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim()) {
      fail(`${source} data[${index}] lacks a non-empty string id`);
    }
    if (seenIds.has(model.id)) {
      fail(`${source} contains duplicate model id ${model.id}`);
    }
    seenIds.add(model.id);
    return {
      contextLength: model.context_length ?? null,
      created: model.created ?? null,
      id: model.id,
      name: model.name ?? null,
      pricingCompletion: model.pricing?.completion ?? null,
      pricingPrompt: model.pricing?.prompt ?? null,
    };
  });
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function readProviderFixture(fileArgument) {
  const file = resolve(fileArgument);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    fail(
      `cannot read --providers-json ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    fail(
      `cannot parse --providers-json ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseProviderPayload(payload, file);
}

async function fetchProviderSurface() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response;
  try {
    response = await fetch(OPENROUTER_MODELS_URL, { signal: controller.signal });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? 'request timed out after 10 seconds'
        : error instanceof Error
          ? error.message
          : String(error);
    fail(`OpenRouter model fetch failed: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    fail(`OpenRouter model fetch returned HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    fail(
      `OpenRouter model response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return parseProviderPayload(payload, 'OpenRouter response');
}

async function collect(options) {
  const repo = validateRepo(options.repo);
  const repoSurface = buildRepoSurface(repo, options.revision);
  const providerSurface = options['providers-json']
    ? readProviderFixture(options['providers-json'])
    : await fetchProviderSurface();

  const repoModelIds = new Set(repoSurface.map((entry) => entry.modelId));
  const providerIds = providerSurface.map((model) => model.id);
  const providerIdSet = new Set(providerIds);
  const repoOpenRouter = repoSurface
    .filter((entry) => entry.providerId === 'openrouter')
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
  const repoOpenRouterIds = repoOpenRouter.map((entry) => entry.modelId);

  return {
    generatedAt: new Date().toISOString(),
    providerNotInRepo: providerSurface.filter((model) => !repoModelIds.has(model.id)),
    providerSurface,
    repoNotInProvider: repoOpenRouter.filter((entry) => !providerIdSet.has(entry.modelId)),
    repoSurface,
    schema: SCRIPT_NAME,
    watchedSetHash: createHash('sha256')
      .update(`${providerIds.join('\n')}\n${repoOpenRouterIds.join('\n')}`)
      .digest('hex'),
  };
}

const options = parseArgs(process.argv.slice(2));
const output = await collect(options);
process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
