import { describe, expect, it } from 'vitest';
import type { ReleaseManifestState } from '../releases/use-release-manifest';
import { buildDownloadViewModel } from './download-view-model';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SOURCE_COMMIT = 'b'.repeat(40);
const ARTIFACT_BASE_URL = 'https://downloads.example.com/brainstrike/';

function asset(
  name: string,
  platform: 'linux' | 'macos' | 'windows',
  architecture: 'arm64' | 'x64',
  packageName: 'appimage' | 'dmg' | 'nsis'
) {
  return {
    architecture,
    digest: DIGEST,
    name,
    package: packageName,
    platform,
    sizeBytes: 125_400_000,
    url: `${ARTIFACT_BASE_URL}v1.0.0/${name}`,
  } as const;
}

const PUBLISHED_STATE: ReleaseManifestState = {
  manifest: {
    channel: 'stable',
    distribution: {
      artifactBaseUrl: ARTIFACT_BASE_URL,
      releasesHubUrl: 'https://downloads.example.com/brainstrike/releases',
    },
    latest: {
      assets: [
        asset('Brainstrike-1.0.0-macos-arm64.dmg', 'macos', 'arm64', 'dmg'),
        asset('Brainstrike-1.0.0-macos-x64.dmg', 'macos', 'x64', 'dmg'),
        asset('Brainstrike-1.0.0-linux-x64.AppImage', 'linux', 'x64', 'appimage'),
      ],
      publishedAt: '2026-08-01T00:00:00Z',
      sourceCommit: SOURCE_COMMIT,
      tag: 'v1.0.0',
      version: '1.0.0',
    },
    product: 'Brainstrike',
    schemaVersion: 2,
  },
  status: 'ready',
};

describe('buildDownloadViewModel', () => {
  it('derives summaries, size labels, and ordered actions from real assets', () => {
    const view = buildDownloadViewModel(PUBLISHED_STATE);

    expect(view.status).toEqual({ kind: 'live', message: 'Latest stable build: v1.0.0' });
    expect(view.releasesHubUrl).toBe('https://downloads.example.com/brainstrike/releases');
    expect(view.platforms).toMatchObject([
      {
        actions: [
          { label: 'Apple silicon DMG', sizeLabel: '125 MB' },
          { label: 'Intel 64-bit DMG', sizeLabel: '125 MB' },
        ],
        name: 'macOS',
        summary: 'DMG / Apple silicon + Intel 64-bit',
      },
      {
        actions: [],
        name: 'Windows',
        summary: 'Not published in v1.0.0',
      },
      {
        actions: [{ label: 'x64 AppImage', sizeLabel: '125 MB' }],
        name: 'Linux',
        summary: 'AppImage / x64',
      },
    ]);
  });

  it('keeps target summaries honest without inventing a public release link', () => {
    const view = buildDownloadViewModel({
      manifest: {
        channel: 'stable',
        distribution: null,
        latest: null,
        product: 'Brainstrike',
        schemaVersion: 2,
      },
      status: 'ready',
    });

    expect(view.status).toEqual({
      kind: 'pending',
      message: 'Public downloads are not available yet. Release targets are configured.',
    });
    expect(view.releasesHubUrl).toBeNull();
    expect(view.platforms.map((platform) => platform.summary)).toEqual([
      'DMG packaging target',
      'NSIS / EXE packaging target',
      'AppImage packaging target',
    ]);
  });

  it('surfaces loading and error states without links or download actions', () => {
    const loading = buildDownloadViewModel({ status: 'loading' });
    const error = buildDownloadViewModel({ error: 'HTTP 503', status: 'error' });

    expect(loading.status).toEqual({ kind: 'loading', message: 'Reading release manifest…' });
    expect(error.status).toEqual({ kind: 'error', message: 'Manifest error: HTTP 503' });
    expect(loading.releasesHubUrl).toBeNull();
    expect(error.releasesHubUrl).toBeNull();
    expect(loading.platforms.every((platform) => platform.actions.length === 0)).toBe(true);
    expect(error.platforms.every((platform) => platform.actions.length === 0)).toBe(true);
  });
});
