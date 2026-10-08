/**
 * Per-worktree setup (spec §6.3): copy the ignored files `.worktreeinclude`
 * names (the Claude Code / Codex standard) and run one setup command with the
 * `BRAINSTRIKE_*` environment (the Conductor idiom).
 *
 * Failure is visible and non-blocking: the worktree exists and is usable
 * either way, and the bounded outcome is persisted on its ledger row.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';
import { sha256OfBuffer } from '@brainstrike/host-capabilities/hooks';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeSetupOutcome, WorktreeSetupSkippedCopy } from '@brainstrike/types';
import { isPathWithin } from './worktree-paths';
import type { WorktreeSetupInput } from './worktree-service';

const logger = createLogger('WorktreeSetup');

export const WORKTREE_SETUP_OUTPUT_CAP_BYTES = 16_384;
export const WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES = WORKTREE_SETUP_OUTPUT_CAP_BYTES * 2;
export const WORKTREE_SETUP_TIMEOUT_MS = 300_000;
export const WORKTREE_SETUP_TERMINATION_GRACE_MS = 2000;
export const WORKTREE_INCLUDE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
export const REPOSITORY_SETUP_SCRIPT = path.join('.brainstrike', 'worktree-setup.sh');
const PORT_BASE = 3000;
const PORT_SPAN = 2000;
const brainstrikePortEnvironmentVariable = 'BRAINSTRIKE_PORT';
const brainstrikeRootPathEnvironmentVariable = 'BRAINSTRIKE_ROOT_PATH';
const brainstrikeWorkspaceNameEnvironmentVariable = 'BRAINSTRIKE_WORKSPACE_NAME';
const brainstrikeWorkspacePathEnvironmentVariable = 'BRAINSTRIKE_WORKSPACE_PATH';

const NONE: WorktreeSetupOutcome = {
  copiedPaths: [],
  output: '',
  reason: null,
  skippedCopies: [],
  status: 'none',
  truncated: false,
};

interface CopyIncludedFilesResult {
  readonly copiedPaths: readonly string[];
  readonly skippedCopies: readonly WorktreeSetupSkippedCopy[];
}

interface CopyBudget {
  copiedBytes: number;
  exhausted: boolean;
  readonly maxBytes: number;
}

type CopyBudgetDecision =
  | { readonly bytes: number; readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly skippedCopy: WorktreeSetupSkippedCopy };

const NO_COPIES: CopyIncludedFilesResult = {
  copiedPaths: [],
  skippedCopies: [],
};

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fsPromises.lstat(current);
      return current;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No existing ancestor was found for "${candidate}".`);
    }
    current = parent;
  }
}

async function measureEntryBytes(
  entryPath: string,
  maxBytes: number
): Promise<{ readonly bytes: number; readonly exceeded: boolean }> {
  const stats = await fsPromises.lstat(entryPath);
  if (!stats.isDirectory()) {
    return { bytes: stats.size, exceeded: stats.size > maxBytes };
  }

  let bytes = 0;
  const directory = await fsPromises.opendir(entryPath);
  for await (const entry of directory) {
    const remaining = maxBytes - bytes;
    const measured = await measureEntryBytes(path.join(entryPath, entry.name), remaining);
    bytes += measured.bytes;
    if (measured.exceeded || bytes > maxBytes) {
      return { bytes, exceeded: true };
    }
  }
  return { bytes, exceeded: false };
}

function resolveCopyMaxBytes(input: WorktreeSetupInput): number {
  const copyMaxBytes = input.copyMaxBytes ?? WORKTREE_INCLUDE_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(copyMaxBytes) || copyMaxBytes <= 0) {
    throw new Error('Worktree include copy limit must be a positive safe integer.');
  }
  return copyMaxBytes;
}

function skippedCopy(pattern: string, relative: string, reason: string): WorktreeSetupSkippedCopy {
  return { path: relative, pattern, reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

/**
 * One relative glob per line; `#` comments and blanks are dropped. Absolute
 * and escaping patterns are rejected before any filesystem operation.
 */
export function parseWorktreeInclude(contents: string): readonly string[] {
  const patterns: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const segments = line.split(/[\\/]/u);
    if (path.posix.isAbsolute(line) || path.win32.isAbsolute(line) || segments.includes('..')) {
      throw new Error(
        `.worktreeinclude patterns must be relative to the repository root: "${line}"`
      );
    }
    patterns.push(line);
  }
  return patterns;
}

/**
 * The Conductor idiom. The port is derived from the worktree path, making it
 * stable across setup runs and collision-unlikely across worktrees. It is not
 * probed or guaranteed free.
 */
export function worktreeSetupEnvironment(input: {
  readonly rootPath: string;
  readonly worktreeName: string;
  readonly worktreePath: string;
}): Record<string, string> {
  const digest = createHash('sha256').update(input.worktreePath).digest();
  const port = PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
  return {
    [brainstrikePortEnvironmentVariable]: String(port),
    [brainstrikeRootPathEnvironmentVariable]: input.rootPath,
    [brainstrikeWorkspaceNameEnvironmentVariable]: input.worktreeName,
    [brainstrikeWorkspacePathEnvironmentVariable]: input.worktreePath,
  };
}

async function resolveSourceRefusal(
  from: string,
  pattern: string,
  relative: string,
  sourceRoot: string
): Promise<WorktreeSetupSkippedCopy | null> {
  let resolvedFrom: string;
  try {
    resolvedFrom = await fsPromises.realpath(from);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return skippedCopy(
        pattern,
        relative,
        'The matched path disappeared before it could be copied.'
      );
    }
    throw error;
  }
  if (isPathWithin(resolvedFrom, sourceRoot)) {
    return null;
  }
  return skippedCopy(pattern, relative, 'The matched path resolves outside the repository root.');
}

async function resolveCopyBudget(
  budget: CopyBudget,
  from: string,
  pattern: string,
  relative: string
): Promise<CopyBudgetDecision> {
  if (budget.exhausted) {
    return {
      kind: 'refused',
      skippedCopy: skippedCopy(
        pattern,
        relative,
        'The worktreeinclude total copy budget was already exhausted.'
      ),
    };
  }
  const measured = await measureEntryBytes(from, budget.maxBytes);
  if (measured.exceeded) {
    return {
      kind: 'refused',
      skippedCopy: skippedCopy(
        pattern,
        relative,
        `The entry exceeds the ${budget.maxBytes}-byte worktreeinclude copy budget.`
      ),
    };
  }
  if (budget.copiedBytes + measured.bytes <= budget.maxBytes) {
    return { bytes: measured.bytes, kind: 'accepted' };
  }
  budget.exhausted = true;
  return {
    kind: 'refused',
    skippedCopy: skippedCopy(
      pattern,
      relative,
      `The entry would exceed the ${budget.maxBytes}-byte total worktreeinclude copy budget.`
    ),
  };
}

async function prepareContainedTargetParent(to: string, worktreeRoot: string): Promise<boolean> {
  const targetParent = path.dirname(to);
  const existingTargetAncestor = await nearestExistingAncestor(targetParent);
  const resolvedTargetAncestor = await fsPromises.realpath(existingTargetAncestor);
  if (!isPathWithin(resolvedTargetAncestor, worktreeRoot)) {
    return false;
  }
  await fsPromises.mkdir(targetParent, { recursive: true });
  const resolvedTargetParent = await fsPromises.realpath(targetParent);
  return isPathWithin(resolvedTargetParent, worktreeRoot);
}

async function copyIncludedFiles(
  sourcePath: string,
  worktreePath: string,
  copyMaxBytes: number
): Promise<CopyIncludedFilesResult> {
  let contents: string;
  try {
    contents = await fsPromises.readFile(path.join(sourcePath, WORKTREE_INCLUDE_FILE), 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return NO_COPIES;
    }
    throw error;
  }

  const [sourceRoot, worktreeRoot] = await Promise.all([
    fsPromises.realpath(sourcePath),
    fsPromises.realpath(worktreePath),
  ]);
  const copied: string[] = [];
  const skippedCopies: WorktreeSetupSkippedCopy[] = [];
  const budget: CopyBudget = { copiedBytes: 0, exhausted: false, maxBytes: copyMaxBytes };
  for (const pattern of parseWorktreeInclude(contents)) {
    for await (const match of glob(pattern, { cwd: sourcePath })) {
      const relative = String(match);
      const from = path.join(sourcePath, relative);
      const to = path.join(worktreePath, relative);
      const sourceRefusal = await resolveSourceRefusal(from, pattern, relative, sourceRoot);
      if (sourceRefusal !== null) {
        skippedCopies.push(sourceRefusal);
        continue;
      }
      const budgetDecision = await resolveCopyBudget(budget, from, pattern, relative);
      if (budgetDecision.kind === 'refused') {
        skippedCopies.push(budgetDecision.skippedCopy);
        continue;
      }
      if (!(await prepareContainedTargetParent(to, worktreeRoot))) {
        skippedCopies.push(
          skippedCopy(pattern, relative, 'The target parent resolves outside the worktree root.')
        );
        continue;
      }
      await fsPromises.cp(from, to, { dereference: false, recursive: true });
      budget.copiedBytes += budgetDecision.bytes;
      copied.push(relative);
    }
  }
  return { copiedPaths: copied.sort(), skippedCopies };
}

interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly reason: string | null;
}

async function resolveSetupCommand(input: WorktreeSetupInput): Promise<ResolvedCommand | null> {
  if (input.settings.setupCommand === 'disabled') {
    return { argv: [], reason: 'Setup is disabled in Settings → Workspace.' };
  }
  if (input.settings.setupCommand !== null) {
    if (input.settings.setupCommand.length === 0) {
      return { argv: [], reason: 'The configured setup command is empty.' };
    }
    return { argv: input.settings.setupCommand, reason: null };
  }

  const script = path.join(input.sourcePath, REPOSITORY_SETUP_SCRIPT);
  // Read the bytes (not just probe existence): a decision is pinned to the
  // script's CONTENTS, so running it requires re-hashing disk here and
  // comparing against the renderer-attested hash — the same read serves both
  // the ENOENT check and the re-hash (mirrors the hooks trust precedent).
  let scriptBytes: Buffer;
  try {
    scriptBytes = await fsPromises.readFile(script);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  const decision = input.repositorySetupDecision;
  // A decision pinned to a DIFFERENT hash than what's on disk right now is
  // treated as no decision at all — fail closed to a visible skip rather than
  // running (or staying skipped) under a stale grant made against different
  // script contents (pull / branch switch / rebase since the decision).
  if (decision && decision.scriptSha256 !== sha256OfBuffer(scriptBytes)) {
    return {
      argv: [],
      reason:
        'Repository setup script consent is required before it can run: the script changed since you last decided.',
    };
  }
  if (decision?.decision === 'denied') {
    return {
      argv: [],
      reason: 'Repository setup script was skipped because you denied permission.',
    };
  }
  if (decision?.decision !== 'approved') {
    return {
      argv: [],
      reason: 'Repository setup script consent is required before it can run.',
    };
  }
  if (process.platform === 'win32') {
    return {
      argv: [],
      reason:
        'This repository ships .brainstrike/worktree-setup.sh, which needs a POSIX shell. Set an explicit setup command in Settings → Workspace to run setup on Windows.',
    };
  }
  return { argv: ['/bin/sh', script], reason: null };
}

function formatSkippedCopies(skippedCopies: readonly WorktreeSetupSkippedCopy[]): string {
  return skippedCopies
    .map(
      (entry) =>
        `[worktreeinclude] Skipped "${entry.path}" (pattern "${entry.pattern}"): ${entry.reason}\n`
    )
    .join('');
}

function capture(
  stdout: Buffer,
  stderr: Buffer,
  skippedCopies: readonly WorktreeSetupSkippedCopy[],
  streamTruncated = false
): { output: string; truncated: boolean } {
  // Each process stream gets its own 16 KiB window so noisy stdout cannot
  // erase all stderr. The persisted combined report is therefore at most
  // 32 KiB, including copy-refusal lines.
  const buffer = Buffer.concat([
    Buffer.from(formatSkippedCopies(skippedCopies), 'utf8'),
    stdout,
    stderr,
  ]);
  if (buffer.byteLength <= WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES && !streamTruncated) {
    return { output: buffer.toString('utf8'), truncated: false };
  }

  let output = buffer.subarray(0, WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES).toString('utf8');
  while (Buffer.byteLength(output, 'utf8') > WORKTREE_SETUP_COMBINED_OUTPUT_CAP_BYTES) {
    output = output.slice(0, -1);
  }
  return { output, truncated: true };
}

interface StreamCapture {
  readonly chunks: Buffer[];
  size: number;
  truncated: boolean;
}

function appendStreamChunk(captureState: StreamCapture, chunk: Buffer): void {
  const remaining = WORKTREE_SETUP_OUTPUT_CAP_BYTES - captureState.size;
  if (remaining <= 0) {
    captureState.truncated = true;
    return;
  }
  const captured = chunk.subarray(0, remaining);
  captureState.chunks.push(captured);
  captureState.size += captured.byteLength;
  if (captured.byteLength < chunk.byteLength) {
    captureState.truncated = true;
  }
}

function resolveTimeoutMs(input: WorktreeSetupInput): number {
  const timeoutMs = input.timeoutMs ?? WORKTREE_SETUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Worktree setup timeout must be a positive safe integer.');
  }
  return timeoutMs;
}

function resolveTerminationGraceMs(input: WorktreeSetupInput): number {
  const graceMs = input.terminationGraceMs ?? WORKTREE_SETUP_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(graceMs) || graceMs <= 0) {
    throw new Error('Worktree setup termination grace must be a positive safe integer.');
  }
  return graceMs;
}

const isWindows = process.platform === 'win32';
const PROCESS_TREE_EXIT_POLL_MS = 10;

/**
 * Signal the setup shell and every descendant. POSIX setup commands run in a
 * dedicated process group so a daemon inheriting stdout/stderr cannot outlive
 * the timeout and keep the service mutex pending forever.
 */
function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (isWindows || typeof child.pid !== 'number') {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may have raced to completion. A direct signal still covers a
    // surviving leader and keeps the timeout's termination attempt explicit.
    child.kill(signal);
  }
}

function isProcessTreeAlive(child: ReturnType<typeof spawn>): boolean {
  if (isWindows || typeof child.pid !== 'number') {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, 'ESRCH');
  }
}

function setupCommandFailureReason(input: {
  readonly code: number | null;
  readonly error?: Error;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}): string {
  if (input.timedOut) {
    return `Setup command timed out after ${input.timeoutMs / 1000}s.`;
  }
  if (input.error) {
    return `Setup command failed: ${input.error.message}`;
  }
  if (input.code !== null) {
    return `Setup command exited with code ${input.code}.`;
  }
  if (input.signal !== null) {
    return `Setup command was terminated by signal ${input.signal}.`;
  }
  return 'Setup command failed without an exit code or signal.';
}

async function executeSetupCommand(
  command: ResolvedCommand,
  input: WorktreeSetupInput,
  copyResult: CopyIncludedFilesResult
): Promise<WorktreeSetupOutcome> {
  const { copiedPaths, skippedCopies } = copyResult;
  const [file, ...args] = command.argv;
  if (file === undefined) {
    const { output, truncated } = capture(Buffer.alloc(0), Buffer.alloc(0), skippedCopies);
    return {
      copiedPaths,
      output,
      reason: command.reason,
      skippedCopies,
      status: 'skipped',
      truncated,
    };
  }

  const env = {
    ...process.env,
    ...worktreeSetupEnvironment({
      rootPath: input.sourcePath,
      worktreeName: path.basename(input.worktree.path),
      worktreePath: input.worktree.path,
    }),
  };
  const timeoutMs = resolveTimeoutMs(input);
  const terminationGraceMs = resolveTerminationGraceMs(input);

  return await new Promise<WorktreeSetupOutcome>((resolve) => {
    const stdout: StreamCapture = { chunks: [], size: 0, truncated: false };
    const stderr: StreamCapture = { chunks: [], size: 0, truncated: false };
    let timedOut = false;
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let processTreeExitTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(file, args, {
      cwd: input.worktree.path,
      detached: !isWindows,
      env,
    });
    const onStdout = (chunk: Buffer): void => appendStreamChunk(stdout, chunk);
    const onStderr = (chunk: Buffer): void => appendStreamChunk(stderr, chunk);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);

    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
      }
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      clearTimeout(processTreeExitTimer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.stdout.destroy();
      child.stderr.destroy();
      const { output, truncated } = capture(
        Buffer.concat(stdout.chunks),
        Buffer.concat(stderr.chunks),
        skippedCopies,
        stdout.truncated || stderr.truncated
      );
      if (!(timedOut || error) && code === 0) {
        resolve({
          copiedPaths,
          output,
          reason: null,
          skippedCopies,
          status: 'succeeded',
          truncated,
        });
        return;
      }
      const reason = setupCommandFailureReason({
        code,
        ...(error ? { error } : {}),
        signal,
        timedOut,
        timeoutMs,
      });
      resolve({ copiedPaths, output, reason, skippedCopies, status: 'failed', truncated });
    };

    const settleAfterProcessTreeExit = (
      code: number | null,
      signal: NodeJS.Signals | null
    ): void => {
      if (settled) {
        return;
      }
      if (!isProcessTreeAlive(child)) {
        settle(code, signal);
        return;
      }
      processTreeExitTimer = setTimeout(
        () => settleAfterProcessTreeExit(code, signal),
        PROCESS_TREE_EXIT_POLL_MS
      );
      processTreeExitTimer.unref?.();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        signalProcessTree(child, 'SIGKILL');
      }, terminationGraceMs);
      escalationTimer.unref?.();
      // `close` waits for inherited stdio fds. If a descendant escaped the
      // group or the platform never reports close, sever the streams and settle
      // with captured-so-far output shortly after SIGKILL escalation.
      deadlineTimer = setTimeout(() => {
        settle(null, null);
      }, terminationGraceMs + 500);
      deadlineTimer.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.once('error', (error: Error) => {
      settle(null, null, error);
    });
    child.once('close', (code, signal) => {
      if (timedOut && !isWindows) {
        settleAfterProcessTreeExit(code, signal);
        return;
      }
      settle(code, signal);
    });
  });
}

export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupOutcome> {
  let copyResult = NO_COPIES;
  try {
    copyResult = await copyIncludedFiles(
      input.sourcePath,
      input.worktree.path,
      resolveCopyMaxBytes(input)
    );
    const command = await resolveSetupCommand(input);
    if (command === null) {
      if (copyResult.copiedPaths.length === 0 && copyResult.skippedCopies.length === 0) {
        return NONE;
      }
      const { output, truncated } = capture(
        Buffer.alloc(0),
        Buffer.alloc(0),
        copyResult.skippedCopies
      );
      return {
        copiedPaths: copyResult.copiedPaths,
        output,
        reason: null,
        skippedCopies: copyResult.skippedCopies,
        status: 'succeeded',
        truncated,
      };
    }
    return await executeSetupCommand(command, input, copyResult);
  } catch (error) {
    logger.warn('worktree setup failed', { error, worktree: input.worktree.path });
    return {
      copiedPaths: copyResult.copiedPaths,
      output: '',
      reason: errorMessage(error),
      skippedCopies: copyResult.skippedCopies,
      status: 'failed',
      truncated: false,
    };
  }
}
