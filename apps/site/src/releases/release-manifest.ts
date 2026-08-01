export type ReleasePlatform = 'linux' | 'macos' | 'windows';
export type ReleaseArchitecture = 'arm64' | 'universal' | 'x64';
export type ReleasePackage = 'appimage' | 'dmg' | 'nsis';

export interface ReleaseDistribution {
  readonly artifactBaseUrl: string;
  readonly releasesHubUrl: string;
}

export interface ReleaseAsset {
  readonly architecture: ReleaseArchitecture;
  readonly digest: string;
  readonly name: string;
  readonly package: ReleasePackage;
  readonly platform: ReleasePlatform;
  readonly sizeBytes: number;
  readonly url: string;
}

export interface PublishedRelease {
  readonly assets: readonly ReleaseAsset[];
  readonly publishedAt: string;
  readonly sourceCommit: string;
  readonly tag: string;
  readonly version: string;
}

export interface ReleaseManifest {
  readonly channel: 'stable';
  readonly distribution: ReleaseDistribution | null;
  readonly latest: PublishedRelease | null;
  readonly product: 'Brainstrike';
  readonly schemaVersion: 2;
}

const PLATFORMS: readonly ReleasePlatform[] = ['linux', 'macos', 'windows'];
const ARCHITECTURES: readonly ReleaseArchitecture[] = ['arm64', 'universal', 'x64'];
const PACKAGES: readonly ReleasePackage[] = ['appimage', 'dmg', 'nsis'];
const PLATFORM_BY_PACKAGE: Readonly<Record<ReleasePackage, ReleasePlatform>> = {
  appimage: 'linux',
  dmg: 'macos',
  nsis: 'windows',
};
const EXTENSION_BY_PACKAGE: Readonly<Record<ReleasePackage, string>> = {
  appimage: '.AppImage',
  dmg: '.dmg',
  nsis: '.exe',
};
const PLATFORM_ORDER: Readonly<Record<ReleasePlatform, number>> = {
  linux: 2,
  macos: 0,
  windows: 1,
};
const ARCHITECTURE_ORDER: Readonly<Record<ReleaseArchitecture, number>> = {
  arm64: 0,
  universal: 1,
  x64: 2,
};
const STABLE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const SOURCE_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA_256 = /^sha256:[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Release manifest field "${field}" must be an object.`);
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unexpected !== undefined) {
    throw new Error(`Release manifest ${field} has unexpected field "${unexpected}".`);
  }
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`Release manifest field "${key}" must be a non-empty trimmed string.`);
  }
  return value;
}

function requireLiteral<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Release manifest field "${field}" is unsupported.`);
  }
  return value as T;
}

function requireSafeHttpsUrl(value: string, field: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Release manifest field "${field}" must be a valid absolute URL.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Release manifest field "${field}" must use HTTPS.`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`Release manifest field "${field}" must not contain credentials.`);
  }
  if (parsed.search.length > 0) {
    throw new Error(`Release manifest field "${field}" must not contain a query.`);
  }
  if (parsed.hash.length > 0) {
    throw new Error(`Release manifest field "${field}" must not contain a fragment.`);
  }
  return parsed;
}

function parseDistribution(value: unknown): ReleaseDistribution {
  const record = requireRecord(value, 'distribution');
  requireExactKeys(record, ['artifactBaseUrl', 'releasesHubUrl'], 'distribution');
  const artifactBaseUrl = requireString(record, 'artifactBaseUrl');
  const releasesHubUrl = requireString(record, 'releasesHubUrl');
  const artifactBase = requireSafeHttpsUrl(artifactBaseUrl, 'artifactBaseUrl');
  requireSafeHttpsUrl(releasesHubUrl, 'releasesHubUrl');
  if (!artifactBase.pathname.endsWith('/')) {
    throw new Error('Release manifest field "artifactBaseUrl" must end with a slash.');
  }
  return { artifactBaseUrl, releasesHubUrl };
}

function requireStableVersion(record: Record<string, unknown>): { tag: string; version: string } {
  const tag = requireString(record, 'tag');
  const version = requireString(record, 'version');
  if (!STABLE_SEMVER.test(version)) {
    throw new Error('Release manifest version must be a valid stable semantic version.');
  }
  if (tag !== `v${version}`) {
    throw new Error('Release manifest tag must equal "v" followed by its version.');
  }
  return { tag, version };
}

function requireTimestamp(record: Record<string, unknown>): string {
  const publishedAt = requireString(record, 'publishedAt');
  const milliseconds = Date.parse(publishedAt);
  const normalized = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  const expected = publishedAt.includes('.') ? publishedAt : publishedAt.replace(/Z$/u, '.000Z');
  if (!(UTC_TIMESTAMP.test(publishedAt) && normalized === expected)) {
    throw new Error('Release manifest publishedAt must be a valid UTC timestamp.');
  }
  return publishedAt;
}

function requireSourceCommit(record: Record<string, unknown>): string {
  const sourceCommit = requireString(record, 'sourceCommit');
  if (!SOURCE_COMMIT.test(sourceCommit)) {
    throw new Error('Release manifest sourceCommit must be a full hexadecimal Git object ID.');
  }
  return sourceCommit;
}

function requireAssetName(record: Record<string, unknown>): string {
  const name = requireString(record, 'name');
  const containsControlCharacter = Array.from(name).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    containsControlCharacter
  ) {
    throw new Error('Release manifest asset name must be a safe file name.');
  }
  return name;
}

function requireSizeBytes(record: Record<string, unknown>): number {
  const sizeBytes = record['sizeBytes'];
  if (!(typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes > 0)) {
    throw new Error('Release manifest asset sizeBytes must be a positive safe integer.');
  }
  return sizeBytes;
}

function requireDigest(record: Record<string, unknown>): string {
  const digest = requireString(record, 'digest');
  if (!SHA_256.test(digest)) {
    throw new Error('Release manifest asset digest must be a lowercase SHA-256 digest.');
  }
  return digest;
}

function parseAsset(value: unknown, distribution: ReleaseDistribution, tag: string): ReleaseAsset {
  const record = requireRecord(value, 'asset');
  requireExactKeys(
    record,
    ['architecture', 'digest', 'name', 'package', 'platform', 'sizeBytes', 'url'],
    'asset'
  );
  const architecture = requireLiteral(record['architecture'], ARCHITECTURES, 'architecture');
  const packageName = requireLiteral(record['package'], PACKAGES, 'package');
  const platform = requireLiteral(record['platform'], PLATFORMS, 'platform');
  if (PLATFORM_BY_PACKAGE[packageName] !== platform) {
    throw new Error(
      `Release manifest package "${packageName}" is not compatible with ${platform}.`
    );
  }
  if (architecture === 'universal' && platform !== 'macos') {
    throw new Error(
      'Release manifest universal architecture is not compatible with this platform.'
    );
  }

  const name = requireAssetName(record);
  if (!name.endsWith(EXTENSION_BY_PACKAGE[packageName])) {
    throw new Error(
      `Release manifest package "${packageName}" is not compatible with asset name "${name}".`
    );
  }
  const url = requireString(record, 'url');
  const parsedUrl = requireSafeHttpsUrl(url, 'url');
  const expectedUrl = new URL(
    `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    distribution.artifactBaseUrl
  );
  if (parsedUrl.href !== expectedUrl.href) {
    throw new Error(
      `Release manifest asset "${name}" URL does not match its distribution, tag, and name.`
    );
  }

  return {
    architecture,
    digest: requireDigest(record),
    name,
    package: packageName,
    platform,
    sizeBytes: requireSizeBytes(record),
    url,
  };
}

function compareAssets(left: ReleaseAsset, right: ReleaseAsset): number {
  return (
    PLATFORM_ORDER[left.platform] - PLATFORM_ORDER[right.platform] ||
    ARCHITECTURE_ORDER[left.architecture] - ARCHITECTURE_ORDER[right.architecture] ||
    compareStrings(left.package, right.package) ||
    compareStrings(left.name, right.name)
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function requireUniqueAssets(assets: readonly ReleaseAsset[]): void {
  const names = new Set<string>();
  const tuples = new Set<string>();
  for (const asset of assets) {
    const normalizedName = asset.name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new Error(`Release manifest contains duplicate asset name "${asset.name}".`);
    }
    names.add(normalizedName);
    const tuple = `${asset.platform}:${asset.architecture}:${asset.package}`;
    if (tuples.has(tuple)) {
      throw new Error(
        `Release manifest contains duplicate platform, architecture, and package tuple "${tuple}".`
      );
    }
    tuples.add(tuple);
  }
}

function parsePublishedRelease(
  value: unknown,
  distribution: ReleaseDistribution
): PublishedRelease {
  const record = requireRecord(value, 'latest');
  requireExactKeys(
    record,
    ['assets', 'publishedAt', 'sourceCommit', 'tag', 'version'],
    'latest release'
  );
  const { tag, version } = requireStableVersion(record);
  const rawAssets = record['assets'];
  if (!(Array.isArray(rawAssets) && rawAssets.length > 0)) {
    throw new Error('Release manifest latest release must contain at least one asset.');
  }
  const assets = rawAssets.map((asset) => parseAsset(asset, distribution, tag));
  requireUniqueAssets(assets);
  assets.sort(compareAssets);
  return {
    assets,
    publishedAt: requireTimestamp(record),
    sourceCommit: requireSourceCommit(record),
    tag,
    version,
  };
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const record = requireRecord(value, 'root');
  requireExactKeys(
    record,
    ['channel', 'distribution', 'latest', 'product', 'schemaVersion'],
    'root'
  );
  if (record['schemaVersion'] !== 2) {
    throw new Error('Release manifest schema version is unsupported.');
  }
  if (record['product'] !== 'Brainstrike') {
    throw new Error('Release manifest product must be Brainstrike.');
  }
  if (record['channel'] !== 'stable') {
    throw new Error('Release manifest channel must be stable.');
  }

  const rawDistribution = record['distribution'];
  const rawLatest = record['latest'];
  if (rawLatest === null) {
    if (rawDistribution !== null) {
      throw new Error('Unpublished release manifest distribution and latest must both be null.');
    }
    return {
      channel: 'stable',
      distribution: null,
      latest: null,
      product: 'Brainstrike',
      schemaVersion: 2,
    };
  }
  if (rawDistribution === null) {
    throw new Error('A published release manifest requires a distribution descriptor.');
  }

  const distribution = parseDistribution(rawDistribution);
  return {
    channel: 'stable',
    distribution,
    latest: parsePublishedRelease(rawLatest, distribution),
    product: 'Brainstrike',
    schemaVersion: 2,
  };
}

export function assetsForPlatform(
  manifest: ReleaseManifest,
  platform: ReleasePlatform
): readonly ReleaseAsset[] {
  return manifest.latest?.assets.filter((asset) => asset.platform === platform) ?? [];
}
