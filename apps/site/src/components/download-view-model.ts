import {
  assetsForPlatform,
  type ReleaseArchitecture,
  type ReleaseAsset,
  type ReleasePackage,
  type ReleasePlatform,
} from '../releases/release-manifest';
import type { ReleaseManifestState } from '../releases/use-release-manifest';

interface PlatformDefinition {
  readonly configuredSummary: string;
  readonly glyph: string;
  readonly name: string;
  readonly platform: ReleasePlatform;
}

const PLATFORM_DEFINITIONS: readonly PlatformDefinition[] = [
  {
    configuredSummary: 'DMG packaging target',
    glyph: '⌘',
    name: 'macOS',
    platform: 'macos',
  },
  {
    configuredSummary: 'NSIS / EXE packaging target',
    glyph: '⊞',
    name: 'Windows',
    platform: 'windows',
  },
  {
    configuredSummary: 'AppImage packaging target',
    glyph: '△',
    name: 'Linux',
    platform: 'linux',
  },
];

const ARCHITECTURE_ORDER: Readonly<Record<ReleaseArchitecture, number>> = {
  arm64: 0,
  universal: 2,
  x64: 1,
};

const PACKAGE_LABELS: Readonly<Record<ReleasePackage, string>> = {
  appimage: 'AppImage',
  dmg: 'DMG',
  nsis: 'EXE / NSIS',
};

export interface DownloadActionView {
  readonly architectureLabel: string;
  readonly asset: ReleaseAsset;
  readonly label: string;
  readonly packageLabel: string;
  readonly sizeLabel: string;
}

export interface DownloadPlatformView {
  readonly actions: readonly DownloadActionView[];
  readonly glyph: string;
  readonly name: string;
  readonly platform: ReleasePlatform;
  readonly summary: string;
}

export type DownloadStatusView =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'live'; readonly message: string }
  | { readonly kind: 'loading'; readonly message: string }
  | { readonly kind: 'pending'; readonly message: string };

export interface DownloadViewModel {
  readonly platforms: readonly DownloadPlatformView[];
  readonly releasesHubUrl: string | null;
  readonly status: DownloadStatusView;
}

function architectureLabel(architecture: ReleaseArchitecture, platform: ReleasePlatform): string {
  if (platform === 'macos') {
    if (architecture === 'arm64') {
      return 'Apple silicon';
    }
    if (architecture === 'x64') {
      return 'Intel 64-bit';
    }
  }
  if (architecture === 'arm64') {
    return 'ARM64';
  }
  if (architecture === 'universal') {
    return 'Universal';
  }
  return 'x64';
}

function formatBytes(sizeBytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = sizeBytes;
  let unitIndex = 0;
  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const fractionDigits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(fractionDigits)} ${units[unitIndex]}`;
}

function uniqueValues<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function publishedSummary(assets: readonly ReleaseAsset[]): string {
  const packages = uniqueValues(assets.map((asset) => PACKAGE_LABELS[asset.package]));
  const architectures = uniqueValues(
    assets.map((asset) => architectureLabel(asset.architecture, asset.platform))
  );
  return `${packages.join(' + ')} / ${architectures.join(' + ')}`;
}

function orderedAssets(assets: readonly ReleaseAsset[]): readonly ReleaseAsset[] {
  return assets.toSorted(
    (left, right) =>
      ARCHITECTURE_ORDER[left.architecture] - ARCHITECTURE_ORDER[right.architecture] ||
      left.package.localeCompare(right.package) ||
      left.name.localeCompare(right.name)
  );
}

function publishedPlatform(
  definition: PlatformDefinition,
  state: Extract<ReleaseManifestState, { readonly status: 'ready' }>
): DownloadPlatformView {
  const latest = state.manifest.latest;
  if (!latest) {
    return {
      actions: [],
      glyph: definition.glyph,
      name: definition.name,
      platform: definition.platform,
      summary: definition.configuredSummary,
    };
  }

  const assets = orderedAssets(assetsForPlatform(state.manifest, definition.platform));
  return {
    actions: assets.map((asset) => {
      const readableArchitecture = architectureLabel(asset.architecture, asset.platform);
      const packageLabel = PACKAGE_LABELS[asset.package];
      return {
        architectureLabel: readableArchitecture,
        asset,
        label: `${readableArchitecture} ${packageLabel}`,
        packageLabel,
        sizeLabel: formatBytes(asset.sizeBytes),
      };
    }),
    glyph: definition.glyph,
    name: definition.name,
    platform: definition.platform,
    summary: assets.length > 0 ? publishedSummary(assets) : `Not published in ${latest.tag}`,
  };
}

function emptyPlatform(
  definition: PlatformDefinition,
  status: ReleaseManifestState['status']
): DownloadPlatformView {
  const summary =
    status === 'loading'
      ? 'Checking release manifest'
      : status === 'error'
        ? 'Release data unavailable'
        : definition.configuredSummary;
  return {
    actions: [],
    glyph: definition.glyph,
    name: definition.name,
    platform: definition.platform,
    summary,
  };
}

function statusView(state: ReleaseManifestState): DownloadStatusView {
  if (state.status === 'loading') {
    return { kind: 'loading', message: 'Reading release manifest…' };
  }
  if (state.status === 'error') {
    return { kind: 'error', message: `Manifest error: ${state.error}` };
  }
  if (!state.manifest.latest) {
    return {
      kind: 'pending',
      message: 'Public downloads are not available yet. Release targets are configured.',
    };
  }
  return { kind: 'live', message: `Latest stable build: ${state.manifest.latest.tag}` };
}

export function buildDownloadViewModel(state: ReleaseManifestState): DownloadViewModel {
  const readyState = state.status === 'ready' ? state : null;
  return {
    platforms: PLATFORM_DEFINITIONS.map((definition) =>
      readyState
        ? publishedPlatform(definition, readyState)
        : emptyPlatform(definition, state.status)
    ),
    releasesHubUrl: readyState?.manifest.distribution?.releasesHubUrl ?? null,
    status: statusView(state),
  };
}
