import { constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Result, Schema, SchemaIssue } from 'effect';

/**
 * BST-1061 / BST-1627: resolve the bundled python-build-standalone CPython for
 * agent Python. There is deliberately NO fallback to a PATH `python`/`python3`
 * — every unusable state below is a distinct typed error so `run_python` can
 * tell the user which half of the stack is missing (no interpreter vs no
 * sandbox). The `python_*` code family must stay disjoint from the
 * CodeExecutor seam's own codes (`no_sandbox_configured`,
 * `exec_capability_mismatch`, ...) and the fence's `fence_*` family — see
 * docs/agents/code-execution.md.
 *
 * The interpreter is unpacked at BUILD time by
 * `scripts/fetch-python-runtime.mjs` (BST-1627): Apple's notarization service
 * scans inside shipped archives and rejects python-build-standalone's
 * ad-hoc-signed Mach-O files, so no tarball ships. The unpacked tree is copied
 * into the package as loose files, which osx-sign signs with the Developer ID
 * identity on macOS. Linux ships the same layout from its derived no-dbm-v1
 * archive. At runtime this module therefore never extracts or writes
 * anything: it checks that the tree's sentinel records the exact archive hash
 * the manifest pins and that the interpreter is executable.
 */
export type PythonRuntimeErrorCode =
  | 'python_manifest_invalid'
  | 'python_runtime_missing'
  | 'python_unsupported_platform';

export class PythonRuntimeError extends Error {
  readonly code: PythonRuntimeErrorCode;

  constructor(code: PythonRuntimeErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class PythonUnsupportedPlatformError extends PythonRuntimeError {
  declare readonly code: 'python_unsupported_platform';

  constructor(message: string) {
    super('python_unsupported_platform', message);
  }
}

export class PythonManifestInvalidError extends PythonRuntimeError {
  declare readonly code: 'python_manifest_invalid';

  constructor(message: string) {
    super('python_manifest_invalid', message);
  }
}

export class PythonRuntimeMissingError extends PythonRuntimeError {
  declare readonly code: 'python_runtime_missing';

  constructor(message: string) {
    super('python_runtime_missing', message);
  }
}

export function isPythonRuntimeError(error: unknown): error is PythonRuntimeError {
  return error instanceof PythonRuntimeError;
}

/**
 * Environment every launch of the bundled interpreter carries (BST-1627). The
 * tree ships inside the package, and on macOS inside the signed bundle, where a
 * `__pycache__` write would break the code signature's sealed resources. A
 * fenced run cannot write there anyway; an approved skill script runs unfenced
 * with the user's own access, so the interpreter must not try.
 */
export const BUNDLED_PYTHON_ENV: Readonly<Record<string, string>> = {
  // biome-ignore lint/style/useNamingConvention: CPython's documented variable name.
  PYTHONDONTWRITEBYTECODE: '1',
};

export interface ResolvePythonBinaryOptions {
  /** Defaults to `process.arch`; injectable for tests. */
  readonly arch?: string;
  /**
   * Absolute dir holding the build-time unpack for THIS target: `python/bin/
   * python3` plus the sentinel written by `scripts/fetch-python-runtime.mjs`.
   */
  readonly installDir: string;
  /** Absolute dir holding `manifest.json`. */
  readonly manifestDir: string;
  /** Defaults to `process.platform`; injectable for tests. */
  readonly platform?: string;
  /**
   * Optional cancellation (a run_skill_script user Stop, or a caller's own
   * timeout budget). Resolution is a manifest read, a sentinel read and an
   * `fs.access`, but callers that thread a signal keep a single contract.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Written by the build-time unpack next to `python/`; holds the sha256 of the
 * archive the tree came from, so the runtime proves the interpreter is the one
 * the manifest pins without re-hashing the archive, which no longer ships.
 */
export const PYTHON_RUNTIME_SENTINEL_FILE_NAME = '.brainstrike-python-runtime-ok';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BINARY_RELATIVE_PATH = path.join('python', 'bin', 'python3');
const LINUX_TARGETS: readonly string[] = ['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu'];
const archiveIntegrityFields = {
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(SHA256_HEX)),
};
const derivedArchiveSchema = Schema.Struct({
  ...archiveIntegrityFields,
  archiveFileName: Schema.String.check(Schema.isPattern(/^cpython-[a-zA-Z0-9+._-]+\.tar\.gz$/)),
  variant: Schema.Literal('no-dbm-v1'),
});
const manifestTargetSchema = Schema.Struct({
  ...archiveIntegrityFields,
  derived: Schema.optionalKey(derivedArchiveSchema),
});
// Keep the old error priority: required strings precede both collection fields.
const manifestStringFields = {
  assetUrlTemplate: Schema.NonEmptyString,
  pythonVersion: Schema.NonEmptyString,
  releaseTag: Schema.NonEmptyString,
  variant: Schema.NonEmptyString,
};
const manifestSchema = Schema.Struct({
  ...manifestStringFields,
  supportedTargets: Schema.Array(Schema.String),
  targets: Schema.Record(Schema.String, manifestTargetSchema),
});

export type PythonRuntimeManifestTarget = typeof manifestTargetSchema.Type;
export type PythonRuntimeManifest = typeof manifestSchema.Type;

function resolveTargetTriple(platform: string, arch: string): string | undefined {
  if (platform === 'darwin' && arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'x86_64-apple-darwin';
  }
  if (platform === 'linux' && arch === 'x64') {
    return 'x86_64-unknown-linux-gnu';
  }
  if (platform === 'linux' && arch === 'arm64') {
    return 'aarch64-unknown-linux-gnu';
  }
  return;
}

function decodeManifest(value: unknown, manifestPath: string): PythonRuntimeManifest {
  const result = Schema.decodeUnknownResult(manifestSchema)(value);
  if (Result.isSuccess(result)) {
    return result.success;
  }
  const issue = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues[0];
  if (!issue) {
    throw new Error('BUG: Python manifest Schema failed without an issue');
  }
  const [field, target] = issue.path ?? [];
  const prefix = `Bundled Python runtime manifest at ${manifestPath}`;
  if (field === undefined) {
    throw new PythonManifestInvalidError(`${prefix} is not an object.`);
  }
  if (typeof field === 'string' && field in manifestStringFields) {
    throw new PythonManifestInvalidError(`${prefix} is missing string field "${field}".`);
  }
  if (field === 'supportedTargets') {
    throw new PythonManifestInvalidError(`${prefix} has an invalid "supportedTargets" list.`);
  }
  if (field === 'targets') {
    if (target === undefined) {
      throw new PythonManifestInvalidError(`${prefix} has an invalid "targets" map.`);
    }
    throw new PythonManifestInvalidError(
      `${prefix} has an invalid entry for target "${String(target)}".`
    );
  }
  throw new Error(`BUG: Unexpected Python manifest Schema field ${String(field)}`);
}

async function loadManifest(manifestDir: string): Promise<PythonRuntimeManifest> {
  const manifestPath = path.join(manifestDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fsPromises.readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new PythonManifestInvalidError(
      `Bundled Python runtime manifest could not be read at ${manifestPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PythonManifestInvalidError(
      `Bundled Python runtime manifest at ${manifestPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return decodeManifest(parsed, manifestPath);
}

export function renderPythonRuntimeAssetFileName(
  manifest: Pick<
    PythonRuntimeManifest,
    'assetUrlTemplate' | 'pythonVersion' | 'releaseTag' | 'variant'
  >,
  target: string
): string {
  const url = manifest.assetUrlTemplate
    .replaceAll('{releaseTag}', manifest.releaseTag)
    .replaceAll('{pythonVersion}', manifest.pythonVersion)
    .replaceAll('{target}', target)
    .replaceAll('{variant}', manifest.variant);
  const fileName = new URL(url).pathname.split('/').at(-1);
  if (!fileName) {
    throw new PythonManifestInvalidError(
      `Bundled Python runtime assetUrlTemplate renders to a URL without a file name: ${url}`
    );
  }
  return fileName;
}

/** The archive a target's tree is unpacked from: Linux's derived payload, else upstream. */
export function pythonRuntimeArchiveSha256(entry: PythonRuntimeManifestTarget): string {
  return entry.derived?.sha256 ?? entry.sha256;
}

function missingRuntime(installDir: string, triple: string, detail: string) {
  return new PythonRuntimeMissingError(
    `The bundled Python runtime for ${triple} is not usable at ${installDir}: ${detail}. ` +
      'In development, prepare it with `node apps/desktop/scripts/fetch-python-runtime.mjs`; ' +
      'in a packaged app this indicates broken packaging (reinstall).'
  );
}

async function readSentinel(installDir: string): Promise<string | undefined> {
  try {
    return (
      await fsPromises.readFile(path.join(installDir, PYTHON_RUNTIME_SENTINEL_FILE_NAME), 'utf8')
    ).trim();
  } catch {
    return;
  }
}

/**
 * Resolves the build-time-unpacked CPython interpreter and returns its
 * ABSOLUTE path. Unsupported platforms classify BEFORE any manifest I/O, so a
 * missing manifest can never mask the real reason. Each call re-validates the
 * tree on disk (manifest, sentinel and `fs.access`, all cheap): nothing is
 * memoised, so a tree removed or replaced under a running process surfaces as
 * the typed `python_runtime_missing` on the next call instead of a raw ENOENT
 * later.
 */
export async function resolvePythonBinary(options: ResolvePythonBinaryOptions): Promise<string> {
  options.signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  for (const [label, dir] of [
    ['manifestDir', options.manifestDir],
    ['installDir', options.installDir],
  ] as const) {
    if (!path.isAbsolute(dir)) {
      throw new Error(`resolvePythonBinary requires an absolute ${label}; received "${dir}".`);
    }
  }
  const triple = resolveTargetTriple(platform, arch);
  const manifest = triple ? await loadManifest(options.manifestDir) : undefined;
  const targetEntry = triple && manifest ? manifest.targets[triple] : undefined;
  if (!(triple && manifest && targetEntry && manifest.supportedTargets.includes(triple))) {
    // Manifest problems on a never-supported platform still read as manifest
    // errors first — but only when a triple exists to look up.
    throw new PythonUnsupportedPlatformError(
      `The bundled Python runtime does not support ${platform}/${arch}` +
        `${triple ? ` (target "${triple}" is not in the manifest)` : ''}. ` +
        'Bundled targets are macOS arm64/x64 and Linux glibc arm64/x64; there is no fallback to a PATH python.'
    );
  }
  if (targetEntry.derived && !LINUX_TARGETS.includes(triple)) {
    throw new PythonManifestInvalidError(
      'The no-dbm-v1 derived runtime is supported for Linux arm64/x64 only.'
    );
  }
  const expectedSha256 = pythonRuntimeArchiveSha256(targetEntry);
  const sentinel = await readSentinel(options.installDir);
  if (sentinel === undefined) {
    throw missingRuntime(options.installDir, triple, 'no build-time unpack sentinel is present');
  }
  if (sentinel !== expectedSha256) {
    throw missingRuntime(
      options.installDir,
      triple,
      `the unpacked tree records archive sha256 ${sentinel}, which does not match the manifest's ${expectedSha256}`
    );
  }
  const binaryPath = path.join(options.installDir, BINARY_RELATIVE_PATH);
  try {
    await fsPromises.access(binaryPath, fsConstants.X_OK);
  } catch {
    throw missingRuntime(
      options.installDir,
      triple,
      `${BINARY_RELATIVE_PATH} is not an executable file`
    );
  }
  // ExecPolicy paths are absolute-only (a literal `~` is rejected, not
  // expanded), so a non-absolute result here would silently fail policy
  // validation in every fence consumer. Final guard, not just a test.
  if (!path.isAbsolute(binaryPath)) {
    throw new Error(`BUG: resolvePythonBinary produced a non-absolute path: ${binaryPath}`);
  }
  return binaryPath;
}
