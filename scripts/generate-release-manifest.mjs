#!/usr/bin/env node
// Generates release-manifest.json (schema v2) from the asset records emitted
// by the release build matrix. Follows the manifest-last contract in
// apps/desktop/RELEASES.md: this runs only after every asset has been uploaded
// and its public URL verified; the manifest is derived from actual upload
// records, never handwritten filenames.
//
// Usage:
//   node scripts/generate-release-manifest.mjs \
//     --tag v0.1.0 \
//     --source-commit <40-hex sha> \
//     --records-dir release-records \
//     [--out release-manifest.json]
//
// Each records file is JSON: an array of
//   { name, sizeBytes, sha256, platform, architecture, package }
// as produced by the build jobs in .github/workflows/release.yml.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_BASE_URL =
  'https://github.com/seandearnaley/brainstrike-releases/releases/download/';
const RELEASES_HUB_URL = 'https://github.com/seandearnaley/brainstrike-releases/releases';

const PLATFORM_BY_PACKAGE = { appimage: 'linux', dmg: 'macos', nsis: 'windows' };
const PLATFORM_ORDER = { linux: 2, macos: 0, windows: 1 };
const ARCHITECTURE_ORDER = { arm64: 0, universal: 1, x64: 2 };
const SHA_256 = /^[a-f0-9]{64}$/u;
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/u;

function fail(message) {
  console.error(`generate-release-manifest: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      fail(`malformed arguments near "${key ?? ''}"`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const tag = args.tag ?? fail('--tag is required');
const sourceCommit = args['source-commit'] ?? fail('--source-commit is required');
const recordsDir = args['records-dir'] ?? fail('--records-dir is required');
const outPath = args.out ?? 'release-manifest.json';

if (!STABLE_TAG.test(tag)) {
  fail(`tag "${tag}" must be v<major>.<minor>.<patch> with no prerelease.`);
}
if (!SOURCE_COMMIT.test(sourceCommit)) {
  fail(`source commit "${sourceCommit}" must be a full 40-hex Git commit id.`);
}
const version = tag.slice(1);

const recordFiles = readdirSync(recordsDir, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith('.json'));
if (recordFiles.length === 0) {
  fail(`no record files found in ${recordsDir}.`);
}

const assets = [];
for (const file of recordFiles) {
  const records = JSON.parse(readFileSync(path.join(recordsDir, file), 'utf8'));
  if (!Array.isArray(records) || records.length === 0) {
    fail(`record file ${file} must contain a non-empty array.`);
  }
  for (const record of records) {
    const { name, sizeBytes, sha256, platform, architecture, package: pkg } = record;
    if (typeof name !== 'string' || name.length === 0) {
      fail(`record in ${file} is missing an asset name.`);
    }
    if (PLATFORM_BY_PACKAGE[pkg] !== platform) {
      fail(`asset "${name}": package "${pkg}" is not valid for platform "${platform}".`);
    }
    if (!(platform in PLATFORM_ORDER && architecture in ARCHITECTURE_ORDER)) {
      fail(`asset "${name}": unsupported platform/architecture "${platform}/${architecture}".`);
    }
    if (!name.includes(version)) {
      fail(`asset "${name}" does not embed release version ${version}.`);
    }
    if (!(Number.isSafeInteger(sizeBytes) && sizeBytes > 0)) {
      fail(`asset "${name}": sizeBytes must be a positive integer.`);
    }
    if (typeof sha256 !== 'string' || !SHA_256.test(sha256)) {
      fail(`asset "${name}": sha256 must be a lowercase 64-hex digest.`);
    }
    assets.push({
      architecture,
      digest: `sha256:${sha256}`,
      name,
      package: pkg,
      platform,
      sizeBytes,
      url: new URL(`${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, ARTIFACT_BASE_URL)
        .href,
    });
  }
}

const tuples = new Set();
for (const asset of assets) {
  const tuple = `${asset.platform}:${asset.architecture}:${asset.package}`;
  if (tuples.has(tuple)) {
    fail(`duplicate platform/architecture/package tuple "${tuple}".`);
  }
  tuples.add(tuple);
}

assets.sort(
  (left, right) =>
    PLATFORM_ORDER[left.platform] - PLATFORM_ORDER[right.platform] ||
    ARCHITECTURE_ORDER[left.architecture] - ARCHITECTURE_ORDER[right.architecture] ||
    left.package.localeCompare(right.package) ||
    left.name.localeCompare(right.name)
);

const manifest = {
  channel: 'stable',
  distribution: {
    artifactBaseUrl: ARTIFACT_BASE_URL,
    releasesHubUrl: RELEASES_HUB_URL,
  },
  latest: {
    assets,
    publishedAt: new Date().toISOString(),
    sourceCommit,
    tag,
    version,
  },
  product: 'Brainstrike',
  schemaVersion: 2,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath} with ${assets.length} assets for ${tag}.`);
