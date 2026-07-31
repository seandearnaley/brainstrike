import { describe, expect, it } from 'vitest';
import { assetsForPlatform, parseReleaseManifest } from './release-manifest';

const unpublishedManifest = {
  channel: 'stable',
  latest: null,
  product: 'Brainstrike',
  releasesHub: 'https://github.com/seandearnaley/brainstrike/releases',
  repository: 'seandearnaley/brainstrike',
  schemaVersion: 1,
};

describe('parseReleaseManifest', () => {
  it('accepts the honest unpublished release state', () => {
    expect(parseReleaseManifest(unpublishedManifest).latest).toBeNull();
  });

  it('accepts named release assets and selects them by platform', () => {
    const manifest = parseReleaseManifest({
      ...unpublishedManifest,
      latest: {
        assets: [
          {
            architecture: 'arm64',
            format: 'DMG',
            name: 'brainstrike-real-asset.dmg',
            platform: 'macos',
            url: 'https://github.com/seandearnaley/brainstrike/releases/download/v1.0.0/brainstrike-real-asset.dmg',
          },
        ],
        publishedAt: '2026-07-31T00:00:00Z',
        tag: 'v1.0.0',
      },
    });
    expect(assetsForPlatform(manifest, 'macos')).toHaveLength(1);
    expect(assetsForPlatform(manifest, 'windows')).toEqual([]);
  });

  it('rejects invented or off-repository download URLs', () => {
    expect(() =>
      parseReleaseManifest({
        ...unpublishedManifest,
        latest: {
          assets: [
            {
              architecture: 'x64',
              format: 'EXE',
              name: 'invented.exe',
              platform: 'windows',
              url: 'https://example.com/invented.exe',
            },
          ],
          publishedAt: '2026-07-31T00:00:00Z',
          tag: 'v1.0.0',
        },
      })
    ).toThrow('must target');
  });

  it('surfaces malformed configuration instead of coercing it', () => {
    expect(() => parseReleaseManifest({ ...unpublishedManifest, schemaVersion: 2 })).toThrow(
      'unsupported'
    );
  });
});
