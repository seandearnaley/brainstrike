import { describe, expect, it } from 'vitest';
import { assetsForPlatform, parseReleaseManifest } from './release-manifest';

const DISTRIBUTION = {
  artifactBaseUrl: 'https://downloads.example.com/brainstrike/stable/',
  releasesHubUrl: 'https://downloads.example.com/brainstrike/',
};

const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function asset(
  overrides: Partial<{
    architecture: 'arm64' | 'universal' | 'x64';
    digest: string;
    name: string;
    package: 'appimage' | 'dmg' | 'nsis';
    platform: 'linux' | 'macos' | 'windows';
    sizeBytes: number;
    url: string;
  }> = {}
) {
  return {
    architecture: 'arm64' as const,
    digest: `sha256:${'a'.repeat(64)}`,
    name: 'Brainstrike-1.2.3-macos-arm64.dmg',
    package: 'dmg' as const,
    platform: 'macos' as const,
    sizeBytes: 128_000_000,
    url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-arm64.dmg`,
    ...overrides,
  };
}

function publishedManifest(assets: readonly unknown[] = [asset()]) {
  return {
    channel: 'stable',
    distribution: DISTRIBUTION,
    latest: {
      assets,
      publishedAt: '2026-08-01T04:00:00Z',
      sourceCommit: SOURCE_COMMIT,
      tag: 'v1.2.3',
      version: '1.2.3',
    },
    product: 'Brainstrike',
    schemaVersion: 2,
  };
}

const unpublishedManifest = {
  channel: 'stable',
  distribution: null,
  latest: null,
  product: 'Brainstrike',
  schemaVersion: 2,
};

describe('parseReleaseManifest', () => {
  it('accepts an unpublished state without a private or dead distribution link', () => {
    expect(parseReleaseManifest(unpublishedManifest)).toEqual(unpublishedManifest);
  });

  it('accepts an origin-agnostic published release and derives compatibility fields', () => {
    const manifest = parseReleaseManifest(publishedManifest());

    expect(manifest.distribution).toEqual(DISTRIBUTION);
    expect(manifest.latest?.assets[0]).toMatchObject({ package: 'dmg' });
  });

  it('sorts assets deterministically and selects them by platform', () => {
    const linux = asset({
      architecture: 'x64',
      name: 'Brainstrike-1.2.3-linux-x64.AppImage',
      package: 'appimage',
      platform: 'linux',
      url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-linux-x64.AppImage`,
    });
    const macIntel = asset({
      architecture: 'x64',
      name: 'Brainstrike-1.2.3-macos-x64.dmg',
      url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-x64.dmg`,
    });
    const windows = asset({
      architecture: 'x64',
      name: 'Brainstrike-1.2.3-windows-x64-setup.exe',
      package: 'nsis',
      platform: 'windows',
      url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-windows-x64-setup.exe`,
    });
    const manifest = parseReleaseManifest(publishedManifest([linux, windows, macIntel, asset()]));

    expect(
      manifest.latest?.assets.map(({ architecture, platform }) => `${platform}:${architecture}`)
    ).toEqual(['macos:arm64', 'macos:x64', 'windows:x64', 'linux:x64']);
    expect(assetsForPlatform(manifest, 'macos')).toHaveLength(2);
  });

  it('keeps a partial published platform matrix explicit and parseable', () => {
    const manifest = parseReleaseManifest(publishedManifest([asset()]));

    expect(assetsForPlatform(manifest, 'macos')).toHaveLength(1);
    expect(assetsForPlatform(manifest, 'windows')).toEqual([]);
    expect(assetsForPlatform(manifest, 'linux')).toEqual([]);
  });

  it.each([
    [{ ...publishedManifest(), distribution: null }, 'requires a distribution'],
    [{ ...unpublishedManifest, distribution: DISTRIBUTION }, 'must both be null'],
  ])('rejects incoherent publication state', (manifest, message) => {
    expect(() => parseReleaseManifest(manifest)).toThrow(message);
  });

  it.each([
    [
      { ...DISTRIBUTION, artifactBaseUrl: 'http://downloads.example.com/stable/' },
      'must use HTTPS',
    ],
    [
      { ...DISTRIBUTION, releasesHubUrl: 'https://user@example.com/releases' },
      'must not contain credentials',
    ],
    [
      { ...DISTRIBUTION, artifactBaseUrl: 'https://downloads.example.com/stable/?channel=1' },
      'must not contain a query',
    ],
    [
      { ...DISTRIBUTION, artifactBaseUrl: 'https://downloads.example.com/stable/#latest' },
      'must not contain a fragment',
    ],
  ])('rejects an unsafe distribution descriptor', (distribution, message) => {
    expect(() => parseReleaseManifest({ ...publishedManifest(), distribution })).toThrow(message);
  });

  it.each([
    ['https://elsewhere.example.com/v1.2.3/Brainstrike-1.2.3-macos-arm64.dmg'],
    [`${DISTRIBUTION.artifactBaseUrl}v1.2.3/not-the-declared-name.dmg`],
  ])('rejects an asset URL that does not exactly match its distribution, tag, and name', (url) => {
    expect(() => parseReleaseManifest(publishedManifest([asset({ url })]))).toThrow(
      'does not match its distribution, tag, and name'
    );
  });

  it.each([
    [`${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-arm64.dmg?mirror=1`, 'query'],
    [
      `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-arm64.dmg#download`,
      'fragment',
    ],
  ])('rejects asset URL state outside the immutable path', (url, message) => {
    expect(() => parseReleaseManifest(publishedManifest([asset({ url })]))).toThrow(message);
  });

  it.each([
    [{ tag: '1.2.3' }, 'must equal'],
    [{ version: '01.2.3' }, 'valid stable semantic version'],
    [{ tag: 'v1.2.3-beta.1', version: '1.2.3-beta.1' }, 'valid stable semantic version'],
    // Build metadata is rejected: `+` diverges between encodeURIComponent and
    // URL parsing, so such a tag could never satisfy the canonical-URL check.
    [{ tag: 'v1.2.3+build.5', version: '1.2.3+build.5' }, 'valid stable semantic version'],
  ])('rejects invalid or disagreeing stable versions', (overrides, message) => {
    const manifest = publishedManifest();
    expect(() =>
      parseReleaseManifest({ ...manifest, latest: { ...manifest.latest, ...overrides } })
    ).toThrow(message);
  });

  it.each([
    [{ publishedAt: 'next Tuesday' }, 'publishedAt'],
    [{ publishedAt: '2026-02-30T04:00:00Z' }, 'publishedAt'],
    [{ sourceCommit: 'main' }, 'sourceCommit'],
    [{ assets: [asset({ sizeBytes: 0 })] }, 'sizeBytes'],
    [{ assets: [asset({ sizeBytes: Number.MAX_SAFE_INTEGER + 1 })] }, 'sizeBytes'],
    [{ assets: [asset({ digest: 'sha256:not-a-digest' })] }, 'digest'],
  ])('rejects malformed release provenance', (overrides, message) => {
    const manifest = publishedManifest();
    expect(() =>
      parseReleaseManifest({ ...manifest, latest: { ...manifest.latest, ...overrides } })
    ).toThrow(message);
  });

  it.each([
    [{ package: 'nsis' as const }, 'not compatible'],
    [{ architecture: 'universal' as const, platform: 'windows' as const }, 'not compatible'],
    [
      {
        name: 'Brainstrike-1.2.3-macos-arm64.exe',
        url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-arm64.exe`,
      },
      'not compatible',
    ],
  ])('rejects incompatible platform, package, or architecture tuples', (overrides, message) => {
    expect(() => parseReleaseManifest(publishedManifest([asset(overrides)]))).toThrow(message);
  });

  it('rejects duplicate asset tuples and duplicate names', () => {
    const first = asset();
    const duplicateTuple = asset({
      name: 'Brainstrike-1.2.3-macos-arm64-copy.dmg',
      url: `${DISTRIBUTION.artifactBaseUrl}v1.2.3/Brainstrike-1.2.3-macos-arm64-copy.dmg`,
    });
    expect(() => parseReleaseManifest(publishedManifest([first, duplicateTuple]))).toThrow(
      'duplicate platform, architecture, and package tuple'
    );

    const duplicateName = asset({ architecture: 'x64' });
    expect(() => parseReleaseManifest(publishedManifest([first, duplicateName]))).toThrow(
      'duplicate asset name'
    );
  });

  it('rejects schema v1 and unexpected fields instead of silently coercing them', () => {
    expect(() => parseReleaseManifest({ ...unpublishedManifest, schemaVersion: 1 })).toThrow(
      'schema version is unsupported'
    );
    expect(() => parseReleaseManifest({ ...unpublishedManifest, releasesHub: 'surprise' })).toThrow(
      'unexpected field'
    );
  });
});
