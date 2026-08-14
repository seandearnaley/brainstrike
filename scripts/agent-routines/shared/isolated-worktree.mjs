import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BRANCH_PATTERN = /^(?!main$)(?!refs\/heads\/main$)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export function createBoundedExecFileRunner({
  maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new Error('maxBufferBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive safe integer');
  }

  return ({ args, cwd, file }) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { cwd, encoding: 'utf8', maxBuffer: maxBufferBytes, timeout: timeoutMs },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed || error.signal) {
              reject(new Error(`command timed out after ${timeoutMs}ms`, { cause: error }));
              return;
            }
            reject(error);
            return;
          }
          resolve({ stderr, stdout });
        }
      );
    });
}

function stdoutOf(result) {
  return typeof result === 'string' ? result : result.stdout;
}

export async function createIsolatedWorktree({
  baseRef = 'origin/main',
  baseSha,
  branchName,
  canonicalPath,
  runGit,
  tempRoot = tmpdir(),
}) {
  if (!BRANCH_PATTERN.test(branchName) || branchName.includes('..') || branchName.endsWith('/')) {
    throw new Error('invalid or forbidden routine branch name');
  }

  const resolvedCanonicalPath = path.resolve(canonicalPath);
  const resolvedTempRoot = path.resolve(tempRoot);
  const relativeTempRoot = path.relative(resolvedCanonicalPath, resolvedTempRoot);
  if (
    relativeTempRoot === '' ||
    (!relativeTempRoot.startsWith(`..${path.sep}`) && relativeTempRoot !== '..')
  ) {
    throw new Error('routine temp root must be outside the canonical checkout');
  }

  const execute =
    runGit ?? (({ args, cwd }) => createBoundedExecFileRunner()({ args, cwd, file: 'git' }));
  const currentBase = stdoutOf(
    await execute({ args: ['rev-parse', '--verify', `${baseRef}^{commit}`], cwd: canonicalPath })
  ).trim();
  if (currentBase !== baseSha) {
    throw new Error(`stale frozen base: expected ${baseSha}, found ${currentBase}`);
  }

  const worktreePath = await mkdtemp(path.join(path.resolve(tempRoot), 'brainstrike-routine-'));
  let attached = false;
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (attached) {
      await execute({ args: ['worktree', 'remove', '--force', worktreePath], cwd: canonicalPath });
    }
    await rm(worktreePath, { force: true, recursive: true });
  };

  try {
    await execute({
      args: ['worktree', 'add', '--detach', worktreePath, baseSha],
      cwd: canonicalPath,
    });
    attached = true;
    await execute({ args: ['switch', '-c', branchName], cwd: worktreePath });
  } catch (error) {
    await cleanup();
    throw error;
  }

  return Object.freeze({ baseSha, branch: branchName, cleanup, path: worktreePath });
}
