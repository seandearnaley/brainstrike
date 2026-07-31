export type ReleasePlatform = 'linux' | 'macos' | 'windows';
export type ReleaseArchitecture = 'arm64' | 'universal' | 'x64';
export type ReleaseFormat = 'AppImage' | 'DMG' | 'EXE';

export interface ReleaseAsset {
  readonly architecture: ReleaseArchitecture;
  readonly format: ReleaseFormat;
  readonly name: string;
  readonly platform: ReleasePlatform;
  readonly url: string;
}

export interface ReleaseManifest {
  readonly channel: 'stable';
  readonly latest: {
    readonly assets: readonly ReleaseAsset[];
    readonly publishedAt: string;
    readonly tag: string;
  } | null;
  readonly product: 'Brainstrike';
  readonly releasesHub: string;
  readonly repository: 'seandearnaley/brainstrike';
  readonly schemaVersion: 1;
}

const PLATFORMS: readonly ReleasePlatform[] = ['linux', 'macos', 'windows'];
const ARCHITECTURES: readonly ReleaseArchitecture[] = ['arm64', 'universal', 'x64'];
const FORMATS: readonly ReleaseFormat[] = ['AppImage', 'DMG', 'EXE'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Release manifest field "${key}" must be a non-empty string.`);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Release manifest field "${field}" is unsupported.`);
  }
  return value as T;
}

function parseAsset(value: unknown): ReleaseAsset {
  if (!isRecord(value)) {
    throw new Error('Release manifest assets must be objects.');
  }
  const url = requireString(value, 'url');
  if (!url.startsWith('https://github.com/seandearnaley/brainstrike/releases/download/')) {
    throw new Error("Release asset URLs must target this repository's GitHub release downloads.");
  }
  return {
    architecture: requireLiteral(value['architecture'], ARCHITECTURES, 'architecture'),
    format: requireLiteral(value['format'], FORMATS, 'format'),
    name: requireString(value, 'name'),
    platform: requireLiteral(value['platform'], PLATFORMS, 'platform'),
    url,
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!isRecord(value)) {
    throw new Error('Release manifest must be an object.');
  }
  if (value['schemaVersion'] !== 1) {
    throw new Error('Release manifest schema version is unsupported.');
  }
  if (value['product'] !== 'Brainstrike') {
    throw new Error('Release manifest product must be Brainstrike.');
  }
  if (value['repository'] !== 'seandearnaley/brainstrike') {
    throw new Error('Release manifest repository does not match Brainstrike.');
  }
  if (value['channel'] !== 'stable') {
    throw new Error('Release manifest channel must be stable.');
  }

  const releasesHub = requireString(value, 'releasesHub');
  if (releasesHub !== 'https://github.com/seandearnaley/brainstrike/releases') {
    throw new Error('Release manifest hub does not match the Brainstrike releases page.');
  }

  const rawLatest = value['latest'];
  if (rawLatest === null) {
    return {
      channel: 'stable',
      latest: null,
      product: 'Brainstrike',
      releasesHub,
      repository: 'seandearnaley/brainstrike',
      schemaVersion: 1,
    };
  }
  if (!(isRecord(rawLatest) && Array.isArray(rawLatest['assets']))) {
    throw new Error('Release manifest latest release is malformed.');
  }

  return {
    channel: 'stable',
    latest: {
      assets: rawLatest['assets'].map(parseAsset),
      publishedAt: requireString(rawLatest, 'publishedAt'),
      tag: requireString(rawLatest, 'tag'),
    },
    product: 'Brainstrike',
    releasesHub,
    repository: 'seandearnaley/brainstrike',
    schemaVersion: 1,
  };
}

export function assetsForPlatform(
  manifest: ReleaseManifest,
  platform: ReleasePlatform
): readonly ReleaseAsset[] {
  return manifest.latest?.assets.filter((asset) => asset.platform === platform) ?? [];
}
