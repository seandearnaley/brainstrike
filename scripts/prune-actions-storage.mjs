#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ARTIFACT_MAX_AGE_HOURS = 24;
const DEFAULT_CACHE_MAX_AGE_HOURS = 72;
const DEFAULT_CACHE_KEEP_RECENT_PER_KEY = 2;
const DEFAULT_DELETE_CONCURRENCY = 4;
const DEFAULT_MAX_DELETIONS = 4000;

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return;
  }
  if (args.indexOf(name, index + 1) !== -1) {
    throw new Error(`${name} can only be provided once`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readPositiveNumber(value, fallback, name) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function readPositiveInteger(value, fallback, name) {
  const parsed = readPositiveNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(args = process.argv.slice(2), env = process.env) {
  const dryRun = args.includes('--dry-run');
  const repo = readFlagValue(args, '--repo') ?? env.GITHUB_REPOSITORY;
  if (!repo?.includes('/')) {
    throw new Error('--repo is required when GITHUB_REPOSITORY is not set');
  }
  return {
    artifactMaxAgeHours: readPositiveNumber(
      readFlagValue(args, '--artifact-max-age-hours'),
      DEFAULT_ARTIFACT_MAX_AGE_HOURS,
      '--artifact-max-age-hours'
    ),
    cacheKeepRecentPerKey: readPositiveInteger(
      readFlagValue(args, '--cache-keep-recent-per-key'),
      DEFAULT_CACHE_KEEP_RECENT_PER_KEY,
      '--cache-keep-recent-per-key'
    ),
    cacheMaxAgeHours: readPositiveNumber(
      readFlagValue(args, '--cache-max-age-hours'),
      DEFAULT_CACHE_MAX_AGE_HOURS,
      '--cache-max-age-hours'
    ),
    deleteConcurrency: readPositiveInteger(
      readFlagValue(args, '--delete-concurrency'),
      DEFAULT_DELETE_CONCURRENCY,
      '--delete-concurrency'
    ),
    dryRun,
    maxDeletions: readPositiveInteger(
      readFlagValue(args, '--max-deletions'),
      DEFAULT_MAX_DELETIONS,
      '--max-deletions'
    ),
    repo,
  };
}

function parseDate(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

function ageHours(value, now) {
  const time = parseDate(value);
  return time === null ? null : (now.getTime() - time) / 3_600_000;
}

export function selectArtifactsForDeletion(artifacts, options) {
  const now = options.now ?? new Date();
  return artifacts.filter((artifact) => {
    if (artifact.expired === true) {
      return true;
    }
    const createdAgeHours = ageHours(artifact.created_at, now);
    return typeof createdAgeHours === 'number' && createdAgeHours >= options.artifactMaxAgeHours;
  });
}

function readCacheDate(cache) {
  return cache.last_accessed_at ?? cache.lastAccessedAt ?? cache.created_at ?? cache.createdAt;
}

function cacheLastUsedTime(cache) {
  return parseDate(readCacheDate(cache)) ?? 0;
}

function cacheAgeHours(cache, now) {
  return ageHours(readCacheDate(cache), now) ?? Number.POSITIVE_INFINITY;
}

export function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

export function selectCachesForDeletion(caches, options) {
  const now = options.now ?? new Date();
  const keepRecentPerKey = options.cacheKeepRecentPerKey;
  const byKey = new Map();
  for (const cache of caches) {
    const key = String(cache.key ?? '');
    const existing = byKey.get(key) ?? [];
    existing.push(cache);
    byKey.set(key, existing);
  }

  const selected = new Set();
  for (const group of byKey.values()) {
    const newestFirst = [...group].sort(
      (left, right) => cacheLastUsedTime(right) - cacheLastUsedTime(left)
    );
    newestFirst.forEach((cache, index) => {
      const stale = cacheAgeHours(cache, now) >= options.cacheMaxAgeHours;
      const duplicateBeyondRetention = index >= keepRecentPerKey;
      if (stale || duplicateBeyondRetention) {
        selected.add(cache);
      }
    });
  }
  return [...selected];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 30s per-request ceiling so a hung GitHub API call can't push the workflow
// against its job-level timeout (the pagination loop and the retry loop both
// rely on individual calls returning in bounded time).
const REQUEST_TIMEOUT_MS = 30_000;

async function requestJson(url, token, init = {}, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Includes AbortError from the per-request timeout above and any
      // transient network failure. Retry the same way we'd retry a 5xx.
      const transient = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      if (transient && attempt < attempts) {
        console.warn(
          `${init.method ?? 'GET'} ${url} aborted after ${REQUEST_TIMEOUT_MS}ms; retrying (${attempt}/${attempts})`
        );
        await delay(1000 * attempt);
        continue;
      }
      throw error;
    }
    if (response.ok) {
      if (response.status === 204) {
        return null;
      }
      return {
        body: await response.json(),
        link: response.headers.get('link'),
      };
    }

    const body = await response.text();
    if (isRetryableStatus(response.status) && attempt < attempts) {
      console.warn(
        `${init.method ?? 'GET'} ${url} failed with ${response.status}; retrying (${attempt}/${attempts})`
      );
      await delay(1000 * attempt);
      continue;
    }
    throw new Error(`${init.method ?? 'GET'} ${url} failed: ${response.status} ${body}`);
  }
  throw new Error(`${init.method ?? 'GET'} ${url} failed after ${attempts} attempts`);
}

function readNextUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function listPaginated(firstUrl, token, readItems) {
  const items = [];
  let url = firstUrl;
  while (url) {
    const page = await requestJson(url, token);
    items.push(...readItems(page.body));
    url = readNextUrl(page.link);
  }
  return items;
}

function apiBase(env) {
  return env.GITHUB_API_URL ?? 'https://api.github.com';
}

async function listArtifacts(apiUrl, repo, token) {
  const url = `${apiUrl}/repos/${repo}/actions/artifacts?per_page=100`;
  return listPaginated(url, token, (page) => page.artifacts ?? []);
}

async function listCaches(apiUrl, repo, token) {
  const url = `${apiUrl}/repos/${repo}/actions/caches?per_page=100`;
  return listPaginated(url, token, (page) => page.actions_caches ?? []);
}

async function deleteArtifact(apiUrl, repo, token, artifactId) {
  await requestJson(`${apiUrl}/repos/${repo}/actions/artifacts/${artifactId}`, token, {
    method: 'DELETE',
  });
}

async function deleteCache(apiUrl, repo, token, cacheId) {
  await requestJson(`${apiUrl}/repos/${repo}/actions/caches/${cacheId}`, token, {
    method: 'DELETE',
  });
}

function bytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function summarizeBytes(items) {
  return items.reduce((total, item) => total + bytes(item.size_in_bytes ?? item.sizeInBytes), 0);
}

export function limitDeletionPlan(artifacts, caches, maxDeletions) {
  const plannedCaches = caches.slice(0, maxDeletions);
  const remaining = Math.max(0, maxDeletions - plannedCaches.length);
  return {
    artifacts: artifacts.slice(0, remaining),
    caches: plannedCaches,
  };
}

async function deleteInBatches(items, concurrency, deleteItem, label) {
  let nextIndex = 0;
  let deleted = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex++;
      await deleteItem(item);
      deleted++;
      if (deleted % 100 === 0 || deleted === items.length) {
        console.log(`Deleted ${deleted}/${items.length} ${label}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () =>
    worker()
  );
  await Promise.all(workers);
}

export async function runCli(args = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(args, env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN is required');
    return 1;
  }

  const apiUrl = apiBase(env);
  const artifacts = await listArtifacts(apiUrl, options.repo, token);
  const caches = await listCaches(apiUrl, options.repo, token);
  const artifactsToDelete = selectArtifactsForDeletion(artifacts, options);
  const cachesToDelete = selectCachesForDeletion(caches, options);
  const planned = limitDeletionPlan(artifactsToDelete, cachesToDelete, options.maxDeletions);

  console.log(
    `Selected ${artifactsToDelete.length}/${artifacts.length} artifacts (${summarizeBytes(
      artifactsToDelete
    )} bytes)`
  );
  console.log(
    `Selected ${cachesToDelete.length}/${caches.length} caches (${summarizeBytes(cachesToDelete)} bytes)`
  );
  console.log(
    `Planned ${planned.artifacts.length} artifact deletes and ${planned.caches.length} cache deletes`
  );

  if (options.dryRun) {
    console.log('Dry run only; no storage entries deleted.');
    return 0;
  }

  await deleteInBatches(
    planned.caches,
    options.deleteConcurrency,
    (cache) => deleteCache(apiUrl, options.repo, token, cache.id),
    'caches'
  );
  await deleteInBatches(
    planned.artifacts,
    options.deleteConcurrency,
    (artifact) => deleteArtifact(apiUrl, options.repo, token, artifact.id),
    'artifacts'
  );
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
