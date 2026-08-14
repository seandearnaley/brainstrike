import path from 'node:path';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function readStdout(result) {
  return typeof result === 'string' ? result : result.stdout;
}

export function freezeRunContext({ baseSha, canonicalPath, watchedPaths, worktreePath }) {
  if (!SHA_PATTERN.test(baseSha)) {
    throw new Error('baseSha must be a full lowercase Git SHA');
  }
  if (path.resolve(canonicalPath) === path.resolve(worktreePath)) {
    throw new Error('routine mutations require an isolated worktree');
  }

  return Object.freeze({
    baseSha,
    canonicalPath: path.resolve(canonicalPath),
    watchedPaths: Object.freeze([...new Set(watchedPaths)].sort()),
    worktreePath: path.resolve(worktreePath),
  });
}

export async function loadFrozenRunContext({
  canonicalPath,
  readGitHubState,
  runGit,
  watchedPaths,
  worktreePath,
}) {
  if (path.resolve(canonicalPath) === path.resolve(worktreePath)) {
    throw new Error('routine mutations require an isolated worktree');
  }

  const status = readStdout(
    await runGit({
      args: ['status', '--porcelain=v1', '--untracked-files=normal'],
      cwd: canonicalPath,
    })
  );
  if (status.trim().length > 0) {
    throw new Error('canonical checkout is dirty; refusing scheduled maintenance');
  }

  let githubState;
  try {
    githubState = await readGitHubState();
  } catch (error) {
    throw new Error('GitHub state is unreadable; refusing scheduled maintenance', { cause: error });
  }
  if (githubState === null || typeof githubState !== 'object') {
    throw new Error('GitHub state is unreadable; refusing scheduled maintenance');
  }

  const baseSha = readStdout(
    await runGit({ args: ['rev-parse', '--verify', 'origin/main^{commit}'], cwd: canonicalPath })
  ).trim();
  return freezeRunContext({ baseSha, canonicalPath, watchedPaths, worktreePath });
}
