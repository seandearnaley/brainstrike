// Gate for scripts/generate-release-manifest.mjs. Without this, the generator
// is only ever exercised during a live, irreversible release — after the
// binaries are already public. The release workflow also validates the
// generated file with the site's production parseReleaseManifest before the
// manifest PR opens; this test catches generator regressions at PR time.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'generate-release-manifest.mjs');
const SOURCE_COMMIT = 'a'.repeat(40);

function record(overrides = {}) {
  return {
    architecture: 'x64',
    name: 'Brainstrike-0.1.0-linux-x64.AppImage',
    package: 'appimage',
    platform: 'linux',
    sha256: 'd'.repeat(64),
    sizeBytes: 1000,
    ...overrides,
  };
}

const FULL_MATRIX = [
  [
    record({
      architecture: 'arm64',
      name: 'Brainstrike-0.1.0-macos-arm64.dmg',
      package: 'dmg',
      platform: 'macos',
      sha256: 'a'.repeat(64),
    }),
    record({
      name: 'Brainstrike-0.1.0-macos-x64.dmg',
      package: 'dmg',
      platform: 'macos',
      sha256: 'b'.repeat(64),
    }),
  ],
  [
    record({
      name: 'Brainstrike-0.1.0-windows-x64.exe',
      package: 'nsis',
      platform: 'windows',
      sha256: 'c'.repeat(64),
    }),
  ],
  [record()],
];

/** Runs the generator over `recordGroups`; returns {status, manifest, stderr}. */
function runGenerator(recordGroups, { tag = 'v0.1.0', sourceCommit = SOURCE_COMMIT } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-'));
  try {
    const recordsDir = path.join(workDir, 'records');
    fs.mkdirSync(recordsDir);
    recordGroups.forEach((records, index) => {
      fs.writeFileSync(path.join(recordsDir, `group-${index}.json`), JSON.stringify(records));
    });
    const outPath = path.join(workDir, 'manifest.json');
    try {
      execFileSync(
        process.execPath,
        [
          script,
          '--tag',
          tag,
          '--source-commit',
          sourceCommit,
          '--records-dir',
          recordsDir,
          '--out',
          outPath,
        ],
        { encoding: 'utf8' }
      );
      return { manifest: JSON.parse(fs.readFileSync(outPath, 'utf8')), status: 0, stderr: '' };
    } catch (error) {
      return { manifest: null, status: error.status, stderr: String(error.stderr) };
    }
  } finally {
    fs.rmSync(workDir, { force: true, recursive: true });
  }
}

describe('generate-release-manifest', () => {
  it('emits a schema-shaped manifest sorted platform-major from a full matrix', () => {
    const { manifest, status } = runGenerator(FULL_MATRIX);
    assert.equal(status, 0);
    assert.equal(manifest.schemaVersion, 2);
    assert.equal(manifest.product, 'Brainstrike');
    assert.equal(manifest.latest.tag, 'v0.1.0');
    assert.equal(manifest.latest.version, '0.1.0');
    assert.equal(manifest.latest.sourceCommit, SOURCE_COMMIT);
    assert.deepEqual(
      manifest.latest.assets.map((asset) => asset.name),
      [
        'Brainstrike-0.1.0-macos-arm64.dmg',
        'Brainstrike-0.1.0-macos-x64.dmg',
        'Brainstrike-0.1.0-windows-x64.exe',
        'Brainstrike-0.1.0-linux-x64.AppImage',
      ]
    );
    for (const asset of manifest.latest.assets) {
      assert.equal(
        asset.url,
        `${manifest.distribution.artifactBaseUrl}v0.1.0/${encodeURIComponent(asset.name)}`
      );
      assert.match(asset.digest, /^sha256:[a-f0-9]{64}$/u);
    }
  });

  it('rejects a prerelease tag', () => {
    const { status, stderr } = runGenerator(FULL_MATRIX, { tag: 'v0.1.0-beta.1' });
    assert.notEqual(status, 0);
    assert.match(stderr, /must be v<major>\.<minor>\.<patch>/);
  });

  it('rejects a short source commit', () => {
    const { status, stderr } = runGenerator(FULL_MATRIX, { sourceCommit: 'abc123' });
    assert.notEqual(status, 0);
    assert.match(stderr, /full 40-hex Git commit id/);
  });

  it('rejects a package/platform mismatch', () => {
    const { status, stderr } = runGenerator([[record({ package: 'dmg' })]]);
    assert.notEqual(status, 0);
    assert.match(stderr, /not valid for platform/);
  });

  it('rejects a duplicate platform/architecture/package tuple', () => {
    const { status, stderr } = runGenerator([[record(), record({ sha256: 'e'.repeat(64) })]]);
    assert.notEqual(status, 0);
    assert.match(stderr, /duplicate platform\/architecture\/package tuple/);
  });

  it('rejects a malformed digest', () => {
    const { status, stderr } = runGenerator([[record({ sha256: 'not-hex' })]]);
    assert.notEqual(status, 0);
    assert.match(stderr, /lowercase 64-hex digest/);
  });

  it('rejects an asset name that does not embed the release version', () => {
    const { status, stderr } = runGenerator([[record({ name: 'Brainstrike-latest.AppImage' })]]);
    assert.notEqual(status, 0);
    assert.match(stderr, /does not embed release version/);
  });
});
