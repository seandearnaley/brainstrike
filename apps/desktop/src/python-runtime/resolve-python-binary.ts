import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { runAtPromiseBoundary } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import { Effect, Exit, Result, Schema, SchemaIssue } from 'effect';

const logger = createLogger('PythonRuntime');

/**
 * BST-1061: resolve the bundled python-build-standalone CPython for agent
 * Python. There is deliberately NO fallback to a PATH `python`/`python3` —
 * every unusable state below is a distinct typed error so `run_python` can
 * tell the user which half of the stack is missing (no interpreter vs no
 * sandbox). The `python_*` code family must stay disjoint from the
 * CodeExecutor seam's own codes (`no_sandbox_configured`,
 * `exec_capability_mismatch`, ...) and the fence's `fence_*` family — see
 * docs/agents/code-execution.md.
 */
export type PythonRuntimeErrorCode =
  | 'python_archive_missing'
  | 'python_checksum_mismatch'
  | 'python_manifest_invalid'
  | 'python_unpack_failed'
  | 'python_unsupported_platform';

export class PythonRuntimeError extends Error {
  readonly code: PythonRuntimeErrorCode;

  constructor(code: PythonRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
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

export class PythonArchiveMissingError extends PythonRuntimeError {
  declare readonly code: 'python_archive_missing';

  constructor(message: string) {
    super('python_archive_missing', message);
  }
}

export class PythonChecksumMismatchError extends PythonRuntimeError {
  declare readonly code: 'python_checksum_mismatch';

  constructor(message: string) {
    super('python_checksum_mismatch', message);
  }
}

export class PythonUnpackFailedError extends PythonRuntimeError {
  declare readonly code: 'python_unpack_failed';

  constructor(message: string, options?: ErrorOptions) {
    super('python_unpack_failed', message, options);
  }
}

export function isPythonRuntimeError(error: unknown): error is PythonRuntimeError {
  return error instanceof PythonRuntimeError;
}

export interface ResolvePythonBinaryOptions {
  /** Defaults to `process.arch`; injectable for tests. */
  readonly arch?: string;
  /** Defaults to `process.platform`; injectable for tests. */
  readonly platform?: string;
  /** Absolute dir holding `manifest.json` + the fetched tarballs. */
  readonly resourcesDir: string;
  /**
   * Optional cancellation (e.g. a run_skill_script user Stop, or a caller's
   * own timeout budget). Hashing destroys and joins its stream; `/usr/bin/tar`
   * receives the signal and joins child close. Filesystem operations finish
   * before cleanup; a committed install still wins over a late abort.
   */
  readonly signal?: AbortSignal | undefined;
  /** Absolute per-user app-data dir; the runtime unpacks under `<dir>/python-runtime/`. */
  readonly userDataDir: string;
}

const SENTINEL_FILE_NAME = '.brainstrike-python-runtime-ok';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const manifestTargetSchema = Schema.Struct({
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sha256: Schema.String.check(Schema.isPattern(SHA256_HEX)),
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
/**
 * Absolute on purpose: this binary unpacks interpreter code that later runs
 * inside the fence, so it must not be resolvable via a caller-controlled PATH.
 * Reachable only on darwin (the manifest's `supportedTargets` gate), where
 * /usr/bin/tar is part of the OS.
 */
const TAR_BINARY = '/usr/bin/tar';

function resolveTargetTriple(platform: string, arch: string): string | undefined {
  if (platform === 'darwin' && arch === 'arm64') {
    return 'aarch64-apple-darwin';
  }
  if (platform === 'darwin' && arch === 'x64') {
    return 'x86_64-apple-darwin';
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

async function loadManifest(resourcesDir: string): Promise<PythonRuntimeManifest> {
  const manifestPath = path.join(resourcesDir, 'manifest.json');
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

async function hashFileSha256(filePath: string, signal: AbortSignal | undefined): Promise<string> {
  return await runAtPromiseBoundary(
    Effect.gen(function* () {
      const hash = createHash('sha256');
      const owned = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const stream = createReadStream(filePath);
          const closed = new Promise<void>((resolve) => stream.once('close', resolve));
          // An Exit-valued Promise retains early failures without an unhandled
          // rejection before the acquiring fiber can begin awaiting the result.
          let releaseListeners!: () => void;
          const result = new Promise<Exit.Exit<void, unknown>>((resolve) => {
            const onData = (chunk: Buffer | string): void => {
              hash.update(chunk);
            };
            const onError = (error: Error): void => {
              resolve(Exit.fail(error));
            };
            const onEnd = (): void => {
              resolve(Exit.void);
            };
            const onAbort = (): void => {
              stream.destroy();
              resolve(Exit.fail(signal?.reason));
            };
            releaseListeners = () => {
              stream.removeListener('data', onData);
              stream.removeListener('error', onError);
              stream.removeListener('end', onEnd);
              signal?.removeEventListener('abort', onAbort);
            };
            stream.on('error', onError);
            stream.on('end', onEnd);
            // Install failure ownership before subscribing to flowing data.
            stream.on('data', onData);
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
              onAbort();
            }
          });
          return { closed, releaseListeners, result, stream };
        }),
        ({ stream, closed, releaseListeners }) =>
          Effect.promise(async () => {
            stream.destroy();
            await closed;
            // Keep handlers through close, then join their cleanup in this scope.
            releaseListeners();
          })
      );
      yield* Effect.flatten(Effect.promise(() => owned.result));
      return hash.digest('hex');
    }).pipe(Effect.scoped)
  );
}

async function extractArchive(
  archivePath: string,
  stagingDir: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const classifyFailure = (error: unknown): unknown => {
    if (signal?.aborted) {
      return error;
    }
    return new PythonUnpackFailedError(
      `Unpacking the bundled Python runtime failed (${TAR_BINARY} -xzf ${archivePath}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  };
  await runAtPromiseBoundary(
    Effect.gen(function* () {
      const owned = yield* Effect.acquireRelease(
        Effect.try({
          catch: classifyFailure,
          try: () => {
            let complete!: (error: Error | null) => void;
            const result = new Promise<void>((resolve, reject) => {
              complete = (error) => {
                if (error) {
                  reject(classifyFailure(error));
                } else {
                  resolve();
                }
              };
            });
            // The callback can fail on abort before process exit and stdio close.
            // Attach a handler before invoking execFile, then await the same result.
            result.catch(() => undefined);
            const child = execFile(
              TAR_BINARY,
              ['-xzf', archivePath, '-C', stagingDir],
              { signal },
              complete
            );
            const onError = (error: Error): void => complete(error);
            child.on('error', onError);
            const closed = new Promise<void>((resolve) =>
              child.once('close', () => {
                child.removeListener('error', onError);
                resolve();
              })
            );
            return { closed, result };
          },
        }),
        ({ closed }) => Effect.promise(() => closed)
      );
      yield* Effect.tryPromise({ catch: (error) => error, try: () => owned.result });
    }).pipe(Effect.scoped)
  );
}

async function isUsableInstall(sentinelPath: string, binaryPath: string, expectedSha256: string) {
  let sentinel: string;
  try {
    sentinel = await fsPromises.readFile(sentinelPath, 'utf8');
  } catch {
    return false;
  }
  if (sentinel.trim() !== expectedSha256) {
    return false;
  }
  try {
    await fsPromises.access(binaryPath, fsConstants.X_OK);
  } catch {
    return false;
  }
  return true;
}

async function unpackArchive({
  archivePath,
  binaryRelativePath,
  expectedSha256,
  installDir,
  signal,
}: {
  archivePath: string;
  binaryRelativePath: string;
  expectedSha256: string;
  installDir: string;
  signal: AbortSignal | undefined;
}): Promise<void> {
  const stagingDir = `${installDir}.staging-${process.pid}-${Date.now()}`;
  await runAtPromiseBoundary(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.succeed(stagingDir), (ownedDir, exit) =>
        Effect.promise(async () => {
          try {
            await fsPromises.rm(ownedDir, { force: true, recursive: true });
          } catch (error) {
            if (Exit.isFailure(exit)) {
              logger.error('Bundled Python staging cleanup failed after an unsuccessful install', {
                error,
                stagingDir: ownedDir,
              });
              return;
            }
            throw new PythonUnpackFailedError(
              `Cleaning up the bundled Python staging directory at ${ownedDir} failed.`,
              { cause: error }
            );
          }
        })
      );
      yield* Effect.tryPromise({
        catch: (error) => error,
        try: async () => {
          // Register removal before mkdir, which may create partial directories
          // and then reject. Native fs awaits settle before the scope can close.
          await fsPromises.rm(stagingDir, { force: true, recursive: true });
          await fsPromises.mkdir(stagingDir, { recursive: true });
          signal?.throwIfAborted();
          await extractArchive(archivePath, stagingDir, signal);
          signal?.throwIfAborted();
          const stagedBinary = path.join(stagingDir, binaryRelativePath);
          try {
            await fsPromises.access(stagedBinary, fsConstants.X_OK);
          } catch {
            throw new PythonUnpackFailedError(
              `The bundled Python archive at ${archivePath} did not contain an executable at ${binaryRelativePath}.`
            );
          }
          await fsPromises.writeFile(
            path.join(stagingDir, SENTINEL_FILE_NAME),
            `${expectedSha256}\n`,
            {
              mode: 0o644,
            }
          );
          signal?.throwIfAborted();
          // A stale install dir only exists here when its sentinel check failed
          // (partial unpack, older archive hash) — replace it wholesale.
          await fsPromises.rm(installDir, { force: true, recursive: true });
          signal?.throwIfAborted();
          try {
            await fsPromises.rename(stagingDir, installDir);
          } catch (error) {
            // A concurrent process (second app instance) may have won the rename.
            // Accept its install only if it verifies; otherwise surface the failure.
            const winnerIsUsable = await isUsableInstall(
              path.join(installDir, SENTINEL_FILE_NAME),
              path.join(installDir, binaryRelativePath),
              expectedSha256
            );
            if (winnerIsUsable) {
              return;
            }
            throw new PythonUnpackFailedError(
              `Installing the bundled Python runtime into ${installDir} failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        },
      });
    }).pipe(Effect.scoped)
  );
}

async function resolvePythonBinaryUncached(options: ResolvePythonBinaryOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  for (const [label, dir] of [
    ['resourcesDir', options.resourcesDir],
    ['userDataDir', options.userDataDir],
  ] as const) {
    if (!path.isAbsolute(dir)) {
      throw new Error(`resolvePythonBinary requires an absolute ${label}; received "${dir}".`);
    }
  }

  const triple = resolveTargetTriple(platform, arch);
  const manifest = triple ? await loadManifest(options.resourcesDir) : undefined;
  const targetEntry = triple && manifest ? manifest.targets[triple] : undefined;
  if (!(triple && manifest && targetEntry && manifest.supportedTargets.includes(triple))) {
    // Manifest problems on a never-supported platform still read as manifest
    // errors first — but only when a triple exists to look up.
    throw new PythonUnsupportedPlatformError(
      `The bundled Python runtime does not support ${platform}/${arch}` +
        `${triple ? ` (target "${triple}" is not in the manifest)` : ''}. ` +
        'BST-1061 ships macOS only; there is deliberately no fallback to a PATH python.'
    );
  }

  const installDir = path.join(
    options.userDataDir,
    'python-runtime',
    `cpython-${manifest.pythonVersion}+${manifest.releaseTag}-${triple}`
  );
  const binaryRelativePath = path.join('python', 'bin', 'python3');
  const binaryPath = path.join(installDir, binaryRelativePath);
  const sentinelPath = path.join(installDir, SENTINEL_FILE_NAME);

  if (await isUsableInstall(sentinelPath, binaryPath, targetEntry.sha256)) {
    return assertAbsolute(binaryPath);
  }

  const archiveFileName = renderPythonRuntimeAssetFileName(manifest, triple);
  const archivePath = path.join(options.resourcesDir, archiveFileName);
  try {
    await fsPromises.access(archivePath, fsConstants.R_OK);
  } catch {
    throw new PythonArchiveMissingError(
      `The bundled Python runtime archive is missing at ${archivePath}. ` +
        'In development, fetch it with `node apps/desktop/scripts/fetch-python-runtime.mjs`; ' +
        'in a packaged app this indicates broken packaging (reinstall).'
    );
  }

  options.signal?.throwIfAborted();
  const actualSha256 = await hashFileSha256(archivePath, options.signal);
  if (actualSha256 !== targetEntry.sha256) {
    throw new PythonChecksumMismatchError(
      `The bundled Python runtime archive at ${archivePath} failed checksum verification ` +
        `(expected sha256 ${targetEntry.sha256}, got ${actualSha256}). Refusing to unpack it.`
    );
  }

  options.signal?.throwIfAborted();
  logger.info('Unpacking bundled Python runtime', { archivePath, installDir });
  await unpackArchive({
    archivePath,
    binaryRelativePath,
    expectedSha256: targetEntry.sha256,
    installDir,
    signal: options.signal,
  });
  return assertAbsolute(binaryPath);
}

function assertAbsolute(binaryPath: string): string {
  // ExecPolicy paths are absolute-only (a literal `~` is rejected, not
  // expanded), so a non-absolute result here would silently fail policy
  // validation in every fence consumer. Final guard, not just a test.
  if (!path.isAbsolute(binaryPath)) {
    throw new Error(`BUG: resolvePythonBinary produced a non-absolute path: ${binaryPath}`);
  }
  return binaryPath;
}

const inflightResolutions = new Map<string, Promise<string>>();

/**
 * Resolves (unpacking on first run) the bundled CPython interpreter and
 * returns its ABSOLUTE path. This is SELF-VALIDATING, not a permanent memo:
 * the cache entry only coalesces CONCURRENT callers onto one in-flight
 * promise, and is cleared the moment that promise settles, win or lose.
 *
 * A permanent success cache was the original design, and it was wrong (PR
 * #2205 review, corroborated independently by two reviewers): factory reset
 * deletes `<userDataDir>/python-runtime` on disk but has no way to reach
 * into this module's in-memory map, and desktop factory reset only reloads
 * the RENDERER (`factory-reset-panel.tsx`) — this main-process module keeps
 * running across a reset. A cached path surviving reset would let the next
 * `python3` skill script in the SAME process hand `runDetachedProcess` a
 * path that no longer exists, failing as a raw OS `ENOENT` instead of one of
 * this module's typed `python_*` errors — precisely the untyped-failure
 * outcome the whole error family exists to prevent.
 *
 * Clearing on every settle instead makes each top-level call re-run
 * `resolvePythonBinaryUncached`, whose `isUsableInstall` check is a cheap
 * sentinel-file read + `fs.access` (not a re-hash or re-unpack) when nothing
 * changed on disk, and correctly re-unpacks from the archive still sitting
 * in `resourcesDir` when the install was actually removed.
 *
 * Unpacks into `<userDataDir>/python-runtime/…`. On macOS that is a SIBLING
 * of the fence's always-deny credential stores (`~/.ssh`, `~/.aws`,
 * `~/.config/gh`, … — see ALWAYS_DENY_READ_PATHS in
 * `@brainstrike/agent/fence-executor`), never a descendant, so the
 * interpreter stays readable inside the fence.
 */
export function resolvePythonBinary(options: ResolvePythonBinaryOptions): Promise<string> {
  const key = [
    options.userDataDir,
    options.resourcesDir,
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  ].join(' ');
  const existing = inflightResolutions.get(key);
  if (existing) {
    return existing;
  }
  const resolution = resolvePythonBinaryUncached(options);
  inflightResolutions.set(key, resolution);
  const clearCacheEntry = () => {
    inflightResolutions.delete(key);
  };
  // Attached to BOTH outcomes via the two-callback form (not `.finally`), so
  // this bookkeeping never creates its own unhandled-rejection warning — the
  // `resolution` promise returned below still carries the rejection for the
  // real caller to handle.
  resolution.then(clearCacheEntry, clearCacheEntry);
  return resolution;
}
