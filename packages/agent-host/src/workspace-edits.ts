import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { refusalError } from '@brainstrike/assistant-contract';
import { BLOBS_DIR, type BlobContent, sha256Hex } from '@brainstrike/state-store';
import {
  HOST_EDIT_BASELINE_MAX_BYTES,
  hostEditBaselineUnavailableReason,
} from './edit-checkpoint-view.js';
import type { HostPlatform, HostWorkspaceEdit, HostWorkspaceEditTracker } from './ports.js';
import type {
  HostEditBaseline,
  HostEditRevertOutcome,
  HostEvent,
  HostLogRow,
  HostParams,
  HostResults,
} from './protocol.js';

/**
 * Host-owned edit checkpoints (Codex TurnDiffTracker / Claude Code file-history
 * model): the first time a run changes a path, Core captures that path's prior
 * state as a content-addressed StateStore blob and commits it with the edit's
 * attribution. Revert restores a run's paths to those baselines. The run log
 * is the only record; thread deletion collects the blobs with the thread.
 */

type Recorded = Extract<HostEvent, { type: 'workspace.edit.recorded' }>;
type Identity = Recorded['before'];

interface ThreadEdits {
  /** Baselines per run, first committed capture per (root, path) wins. */
  readonly baselines: Map<string, Map<string, HostEditBaseline>>;
  /** Commit order. */
  readonly entries: Map<string, Recorded>;
  readonly reverted: Set<string>;
}

interface Observation {
  readonly baseline: HostEditBaseline;
  readonly blob?: BlobContent;
  readonly identity: Identity;
}

const ABSENT: Identity = { existed: false, hash: null, size: null };

function baselineKey(rootId: string, relativePath: string): string {
  return `${rootId}\0${relativePath}`;
}

/**
 * Whether the live root owner's path names the folder an edit recorded. The
 * owner keeps the path the person picked, which may reach the folder through a
 * symlink (macOS: /var/folders is /private/var/folders); a folder that is gone
 * or moved is not the same root.
 */
async function isSameRootFolder(live: string, recorded: string): Promise<boolean> {
  if (path.resolve(live) === recorded) {
    return true;
  }
  const [liveFolder, recordedFolder] = await Promise.all([
    realpath(live).catch(() => undefined),
    realpath(recorded).catch(() => undefined),
  ]);
  return liveFolder !== undefined && liveFolder === recordedFolder;
}

/** Root-relative POSIX path of `absolutePath`, refusing anything outside `rootPath`. */
export function workspaceRelativePath(rootPath: string, absolutePath: string): string {
  if (!(path.isAbsolute(rootPath) && path.isAbsolute(absolutePath))) {
    throw new Error('Workspace edits require absolute root and file paths');
  }
  const relative = path.relative(path.resolve(rootPath), path.resolve(absolutePath));
  const segments = relative.split(path.sep);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Workspace edit path is outside its admitted root');
  }
  return segments.join('/');
}

function absoluteWithin(rootPath: string, relativePath: string): string {
  return path.join(rootPath, ...relativePath.split('/'));
}

function streamHash(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(absolutePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function isMissing(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The identity a later conflict gate compares; follows a symlink like the tools' own reads. */
async function observeIdentity(absolutePath: string): Promise<Identity> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(absolutePath);
  } catch (cause) {
    if (isMissing(cause)) {
      return ABSENT;
    }
    throw cause;
  }
  if (!stats.isFile()) {
    return { existed: true, hash: null, size: null };
  }
  return { existed: true, hash: await streamHash(absolutePath), size: stats.size };
}

/** Identity plus, on a run's first touch, the baseline and the blob that holds its bytes. */
async function observe(absolutePath: string, relativePath: string): Promise<Observation> {
  let link: Awaited<ReturnType<typeof lstat>>;
  try {
    link = await lstat(absolutePath);
  } catch (cause) {
    if (isMissing(cause)) {
      return { baseline: { kind: 'absent', path: relativePath }, identity: ABSENT };
    }
    throw cause;
  }
  if (link.isSymbolicLink()) {
    return {
      baseline: { kind: 'unavailable', path: relativePath, reason: 'symlink' },
      identity: await observeIdentity(absolutePath),
    };
  }
  if (!link.isFile()) {
    return {
      baseline: { kind: 'unavailable', path: relativePath, reason: 'not_a_file' },
      identity: { existed: true, hash: null, size: null },
    };
  }
  if (link.size > HOST_EDIT_BASELINE_MAX_BYTES) {
    return {
      baseline: { kind: 'unavailable', path: relativePath, reason: 'too_large' },
      identity: { existed: true, hash: await streamHash(absolutePath), size: link.size },
    };
  }
  const bytes = await readFile(absolutePath);
  const text = bytes.toString('utf8');
  const encoding = Buffer.from(text, 'utf8').equals(bytes) ? 'utf8' : 'base64';
  const content = encoding === 'utf8' ? text : bytes.toString('base64');
  const blob = sha256Hex(content);
  const hash = sha256Hex(bytes);
  return {
    baseline: {
      blob,
      bytes: bytes.byteLength,
      encoding,
      hash,
      kind: 'content',
      mode: link.mode & 0o7777,
      path: relativePath,
    },
    blob: { content, hash: blob },
    identity: { existed: true, hash, size: bytes.byteLength },
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.existed === b.existed && a.hash === b.hash && a.size === b.size;
}

function atBaseline(current: Identity, baseline: HostEditBaseline): boolean {
  if (baseline.kind === 'absent') {
    return !current.existed;
  }
  return baseline.kind === 'content' && current.existed && current.hash === baseline.hash;
}

/** Fail closed: an expected content with no recorded hash never matches. */
function matchesExpected(
  current: Identity,
  expected: { readonly existed: boolean; readonly hash: string | null }
): boolean {
  if (current.existed !== expected.existed) {
    return false;
  }
  return !expected.existed || (expected.hash !== null && current.hash === expected.hash);
}

/** The root-relative paths one edit touches; a rename lists its source first. */
function editPaths(edit: HostWorkspaceEdit): {
  readonly paths: readonly string[];
  readonly source?: string;
  readonly target: string;
} {
  const target = workspaceRelativePath(edit.rootPath, edit.absolutePath);
  if ((edit.op === 'rename') !== (edit.fromAbsolutePath !== undefined)) {
    throw new Error('Only a rename names a source path');
  }
  if (edit.fromAbsolutePath === undefined) {
    return { paths: [target], target };
  }
  const source = workspaceRelativePath(edit.rootPath, edit.fromAbsolutePath);
  if (source === target) {
    throw new Error('A rename source and destination must differ');
  }
  return { paths: [source, target], source, target };
}

async function settle<T>(
  mutate: () => Promise<T>
): Promise<
  { readonly ok: true; readonly value: T } | { readonly cause: unknown; readonly ok: false }
> {
  try {
    return { ok: true, value: await mutate() };
  } catch (cause) {
    return { cause, ok: false };
  }
}

/** Restore `absolutePath` to `baseline`, verifying the blob's bytes against the baseline hash. */
async function restoreBaseline(
  rootPath: string,
  absolutePath: string,
  baseline: Extract<HostEditBaseline, { kind: 'absent' | 'content' }>,
  readBlob: (hash: string) => Promise<string>
): Promise<void> {
  if (baseline.kind === 'absent') {
    await rm(absolutePath, { force: true });
    // Mirror the snapshot engine: prune the empty directories the edit left, bounded at the root.
    const root = path.resolve(rootPath);
    let directory = path.dirname(path.resolve(absolutePath));
    while (directory !== root && directory.startsWith(`${root}${path.sep}`)) {
      try {
        await rmdir(directory);
      } catch (cause) {
        if (isMissing(cause)) {
          directory = path.dirname(directory);
          continue;
        }
        break;
      }
      directory = path.dirname(directory);
    }
    return;
  }
  const stored = await readBlob(baseline.blob);
  if (sha256Hex(stored) !== baseline.blob) {
    throw new Error('Edit baseline blob is damaged');
  }
  const bytes =
    baseline.encoding === 'utf8' ? Buffer.from(stored, 'utf8') : Buffer.from(stored, 'base64');
  if (bytes.byteLength !== baseline.bytes || sha256Hex(bytes) !== baseline.hash) {
    throw new Error('Edit baseline content does not match its recorded identity');
  }
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.${randomUUID()}.restore`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await chmod(temporary, baseline.mode);
    await rename(temporary, absolutePath);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

export interface HostEditScope {
  /** Refuses once the thread is deleted or the host closes. */
  assertCurrent(): void;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolId: string;
}

export interface HostEditRevertRequest {
  readonly entryId?: string | undefined;
  readonly force: boolean;
  readBlob(hash: string): Promise<string>;
  resolveRoot(rootId: string): Promise<string>;
  readonly runId: string;
  /** An aborted revert throws rather than committing a partial outcome list. */
  readonly signal: AbortSignal;
  readonly threadId: string;
}

/** Core-owned fold and executor; the committed log is the only record. */
export class HostWorkspaceEdits {
  private readonly threads = new Map<string, ThreadEdits>();
  private readonly locks = new Map<string, Promise<void>>();

  private thread(threadId: string): ThreadEdits {
    let edits = this.threads.get(threadId);
    if (!edits) {
      edits = { baselines: new Map(), entries: new Map(), reverted: new Set() };
      this.threads.set(threadId, edits);
    }
    return edits;
  }

  fold(row: HostLogRow): void {
    const event = row.event;
    if (event.type === 'workspace.edit.recorded') {
      const edits = this.thread(row.threadId);
      if (edits.entries.has(event.entryId)) {
        throw new Error('Workspace edit entry was committed twice');
      }
      edits.entries.set(event.entryId, event);
      let run = edits.baselines.get(event.runId);
      if (!run) {
        run = new Map();
        edits.baselines.set(event.runId, run);
      }
      for (const baseline of event.baselines) {
        const key = baselineKey(event.rootId, baseline.path);
        if (!run.has(key)) {
          run.set(key, baseline);
        }
      }
    } else if (event.type === 'workspace.edit.reverted') {
      const edits = this.thread(row.threadId);
      for (const outcome of event.outcomes) {
        if (outcome.status === 'reverted') {
          edits.reverted.add(outcome.entryId);
        }
      }
    }
  }

  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  /** Serialize every tracked edit and restore of the same absolute paths, host-wide. */
  private async exclusive<T>(paths: readonly string[], work: () => Promise<T>): Promise<T> {
    const keys = [...new Set(paths.map((candidate) => path.resolve(candidate)))].sort();
    const release = Promise.withResolvers<void>();
    const previous = keys.map((key) => this.locks.get(key) ?? Promise.resolve());
    const held = release.promise;
    for (const key of keys) {
      this.locks.set(key, held);
    }
    await Promise.all(previous);
    try {
      return await work();
    } finally {
      release.resolve();
      for (const key of keys) {
        if (this.locks.get(key) === held) {
          this.locks.delete(key);
        }
      }
    }
  }

  tracker(
    scope: HostEditScope,
    commit: (event: Recorded, blobs: readonly BlobContent[]) => Promise<unknown>
  ): HostWorkspaceEditTracker {
    return {
      track: <T>(edit: HostWorkspaceEdit, mutate: () => Promise<T>): Promise<T> => {
        const touched = editPaths(edit);
        return this.exclusive(
          touched.paths.map((relative) => absoluteWithin(edit.rootPath, relative)),
          () => this.trackExclusive(scope, edit, touched, mutate, commit)
        );
      },
    };
  }

  private async trackExclusive<T>(
    scope: HostEditScope,
    edit: HostWorkspaceEdit,
    touched: ReturnType<typeof editPaths>,
    mutate: () => Promise<T>,
    commit: (event: Recorded, blobs: readonly BlobContent[]) => Promise<unknown>
  ): Promise<T> {
    scope.assertCurrent();
    scope.signal.throwIfAborted();
    const absolute = (relative: string) => absoluteWithin(edit.rootPath, relative);
    const run = this.thread(scope.threadId).baselines.get(scope.runId);
    const before: Observation[] = [];
    for (const relative of touched.paths) {
      before.push(await observe(absolute(relative), relative));
    }
    const outcome = await settle(mutate);
    const after: Identity[] = [];
    for (const relative of touched.paths) {
      after.push(await observeIdentity(absolute(relative)));
    }
    const changed = before.some((observed, index) => {
      const now = after[index];
      return !(now && sameIdentity(observed.identity, now));
    });
    if (!(outcome.ok || changed)) {
      throw outcome.cause;
    }
    // Only a run's first touch of a path captures its baseline.
    const firstTouch = before.filter(
      (observed) => !run?.has(baselineKey(edit.rootId, observed.baseline.path))
    );
    const blobs = firstTouch.flatMap((observed) => (observed.blob ? [observed.blob] : []));
    const beforeIdentity = before[0]?.identity;
    const afterIdentity = after.at(-1);
    if (!(beforeIdentity && afterIdentity)) {
      throw new Error('Workspace edit observation is missing');
    }
    scope.assertCurrent();
    await commit(
      {
        after: afterIdentity,
        baselines: firstTouch.map((observed) => observed.baseline),
        before: beforeIdentity,
        ...(blobs.length > 0 ? { blobRefs: [...new Set(blobs.map((blob) => blob.hash))] } : {}),
        entryId: randomUUID(),
        ...(touched.source === undefined ? {} : { fromPath: touched.source }),
        op: edit.op,
        path: touched.target,
        rootId: edit.rootId,
        rootPath: path.resolve(edit.rootPath),
        runId: scope.runId,
        toolCallId: scope.toolCallId,
        toolId: scope.toolId,
        type: 'workspace.edit.recorded',
      },
      blobs
    );
    if (!outcome.ok) {
      throw outcome.cause;
    }
    return outcome.value;
  }

  /** Newest-first, one restore per (root, path), each gated on the entry's own after-state. */
  /**
   * The run's revertible edits (every prior state kept) and how many are
   * reverted once these outcomes commit: the Task Ledger revert label's counts.
   */
  revertTally(
    threadId: string,
    runId: string,
    outcomes: readonly HostEditRevertOutcome[]
  ): { readonly reverted: number; readonly total: number } {
    const edits = this.threads.get(threadId);
    const run = edits?.baselines.get(runId);
    if (!(edits && run)) {
      return { reverted: 0, total: 0 };
    }
    const now = new Set(
      outcomes.flatMap((outcome) => (outcome.status === 'reverted' ? [outcome.entryId] : []))
    );
    const revertible = [...edits.entries.values()].filter(
      (entry) =>
        entry.runId === runId &&
        (entry.fromPath === undefined ? [entry.path] : [entry.fromPath, entry.path]).every(
          (relative) => {
            const baseline = run.get(baselineKey(entry.rootId, relative));
            return baseline !== undefined && baseline.kind !== 'unavailable';
          }
        )
    );
    return {
      reverted: revertible.filter(
        (entry) => edits.reverted.has(entry.entryId) || now.has(entry.entryId)
      ).length,
      total: revertible.length,
    };
  }

  async revert(request: HostEditRevertRequest): Promise<HostEditRevertOutcome[]> {
    const edits = this.threads.get(request.threadId);
    const runEntries = [...(edits?.entries.values() ?? [])].filter(
      (entry) => entry.runId === request.runId
    );
    let scope: Recorded[];
    if (request.entryId === undefined) {
      scope = runEntries.filter((entry) => !edits?.reverted.has(entry.entryId)).reverse();
    } else {
      const entry = runEntries.find((candidate) => candidate.entryId === request.entryId);
      if (!entry) {
        throw refusalError('input', 'checkpoint.unknown', 'Unknown edit checkpoint for this run');
      }
      scope = [entry];
    }
    const handled = new Set<string>();
    const roots = new Map<string, Promise<string | Error>>();
    const outcomes: HostEditRevertOutcome[] = [];
    for (const entry of scope) {
      request.signal.throwIfAborted();
      outcomes.push(await this.revertEntry(request, entry, handled, roots));
    }
    request.signal.throwIfAborted();
    return outcomes;
  }

  private async revertEntry(
    request: HostEditRevertRequest,
    entry: Recorded,
    handled: Set<string>,
    roots: Map<string, Promise<string | Error>>
  ): Promise<HostEditRevertOutcome> {
    const refuse = (
      status: 'conflict' | 'not_revertible',
      reason: string
    ): HostEditRevertOutcome => ({ entryId: entry.entryId, reason, status });
    if (this.threads.get(request.threadId)?.reverted.has(entry.entryId)) {
      return refuse('not_revertible', 'This edit was already reverted.');
    }
    const expected = new Map<string, { readonly existed: boolean; readonly hash: string | null }>(
      entry.fromPath === undefined
        ? [[entry.path, { existed: entry.after.existed, hash: entry.after.hash }]]
        : [
            [entry.fromPath, { existed: false, hash: null }],
            [entry.path, { existed: true, hash: entry.after.hash }],
          ]
    );
    const run = this.threads.get(request.threadId)?.baselines.get(entry.runId);
    const baselines = new Map<string, Extract<HostEditBaseline, { kind: 'absent' | 'content' }>>();
    for (const relative of expected.keys()) {
      const baseline = run?.get(baselineKey(entry.rootId, relative));
      if (!baseline) {
        return refuse('not_revertible', 'No prior state was recorded for this edit.');
      }
      if (baseline.kind === 'unavailable') {
        return refuse(
          'not_revertible',
          `"${relative}": ${hostEditBaselineUnavailableReason(baseline.reason)}`
        );
      }
      baselines.set(relative, baseline);
    }
    let resolved = roots.get(entry.rootId);
    if (!resolved) {
      resolved = request.resolveRoot(entry.rootId).then(
        (live) => live,
        (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
      );
      roots.set(entry.rootId, resolved);
    }
    const live = await resolved;
    if (live instanceof Error || !(await isSameRootFolder(live, entry.rootPath))) {
      return refuse(
        'not_revertible',
        'Its workspace folder is no longer connected at the same location. Re-open the folder and try again.'
      );
    }
    const pending = [...expected.keys()].filter(
      (relative) => !handled.has(baselineKey(entry.rootId, relative))
    );
    const absolute = (relative: string) => absoluteWithin(entry.rootPath, relative);
    return this.exclusive(pending.map(absolute), async () => {
      const restore: string[] = [];
      for (const relative of pending) {
        const current = await observeIdentity(absolute(relative));
        const baseline = baselines.get(relative);
        const expectation = expected.get(relative);
        if (!(baseline && expectation)) {
          throw new Error('Workspace edit revert plan is incomplete');
        }
        if (atBaseline(current, baseline)) {
          continue;
        }
        if (!(request.force || matchesExpected(current, expectation))) {
          return refuse('conflict', 'The file changed since this edit was recorded.');
        }
        restore.push(relative);
      }
      // A rename restores its source before removing its destination.
      for (const relative of restore) {
        const baseline = baselines.get(relative);
        if (!baseline) {
          throw new Error('Workspace edit revert plan is incomplete');
        }
        await restoreBaseline(entry.rootPath, absolute(relative), baseline, request.readBlob);
      }
      for (const relative of pending) {
        handled.add(baselineKey(entry.rootId, relative));
      }
      return { entryId: entry.entryId, status: 'reverted' as const };
    });
  }
}

/** The execution an edit is attributed to; `retired` fences a deleted thread or closing host. */
export function hostEditScope(
  run: { readonly controller: AbortController; readonly id: string; readonly threadId: string },
  action: { readonly toolCallId: string; readonly toolId: string },
  retired: () => boolean
): HostEditScope {
  return {
    assertCurrent: () => {
      if (retired()) {
        throw new Error('Workspace edit authority retired');
      }
    },
    runId: run.id,
    signal: run.controller.signal,
    threadId: run.threadId,
    toolCallId: action.toolCallId,
    toolId: action.toolId,
  };
}

/** `checkpoint/revert` with the live root owner; thread deletion and host close abort it. */
/**
 * The Task Ledger `edit_revert` label: every revertible edit reverted rejects
 * the run's work outright (`failed`), a partial revert is `mixed`. A revert
 * that restored nothing commits no label; a user verdict outranks this one.
 */
function revertVerdict(
  edits: HostWorkspaceEdits,
  params: HostParams<'checkpoint/revert'>,
  outcomes: readonly HostEditRevertOutcome[]
): HostEvent[] {
  if (!outcomes.some((outcome) => outcome.status === 'reverted')) {
    return [];
  }
  const { reverted, total } = edits.revertTally(params.threadId, params.runId, outcomes);
  return [
    {
      detail: `${reverted}/${total} edits reverted`,
      runId: params.runId,
      source: 'edit_revert',
      type: 'run.verdict',
      verdict: reverted === total ? 'failed' : 'mixed',
    },
  ];
}

export async function revertHostRunEdits(
  edits: HostWorkspaceEdits,
  params: HostParams<'checkpoint/revert'>,
  owner: {
    readonly pending: Map<AbortController, string>;
    readonly platform: Pick<HostPlatform, 'resolveWorkspaceRoot'>;
    readonly runs: Iterable<{ readonly terminal: boolean; readonly threadId: string }>;
    readonly storeRoot: string;
  }
): Promise<{
  /** The outcomes, then the run's revert label when this revert restored anything. */
  readonly events: readonly HostEvent[];
  readonly result: HostResults['checkpoint/revert'];
}> {
  for (const run of owner.runs) {
    if (run.threadId === params.threadId && !run.terminal) {
      throw refusalError(
        'conflict',
        'checkpoint.run-active',
        'Checkpoint revert is refused while the thread has an active run'
      );
    }
  }
  const resolveWorkspaceRoot = owner.platform.resolveWorkspaceRoot?.bind(owner.platform);
  if (!resolveWorkspaceRoot) {
    throw refusalError(
      'availability',
      'checkpoint.root-owner-missing',
      'Checkpoint revert requires the live workspace root owner'
    );
  }
  const controller = new AbortController();
  owner.pending.set(controller, params.threadId);
  try {
    const outcomes = await edits.revert({
      entryId: params.entryId,
      force: params.force === true,
      readBlob: (hash) => readFile(path.join(owner.storeRoot, BLOBS_DIR, hash), 'utf8'),
      resolveRoot: (rootId) => resolveWorkspaceRoot({ rootId, signal: controller.signal }),
      runId: params.runId,
      signal: controller.signal,
      threadId: params.threadId,
    });
    const reverted: HostEvent = {
      commandId: params.commandId,
      outcomes,
      runId: params.runId,
      type: 'workspace.edit.reverted',
    };
    return {
      events: [reverted, ...revertVerdict(edits, params, outcomes)],
      result: { outcomes },
    };
  } finally {
    owner.pending.delete(controller);
  }
}
