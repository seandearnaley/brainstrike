import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

function stdoutOf(result) {
  return typeof result === 'string' ? result : result?.stdout;
}

async function defaultRunGit({ args, cwd, timeoutMs }) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });
}

async function resolveSha({ args, cwd, runGit, timeoutMs }) {
  const sha = stdoutOf(await runGit({ args, cwd, timeoutMs }))?.trim();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`git returned an invalid SHA for ${args.join(' ')}`);
  }
  return sha;
}

export async function readCurrentHeadSha({
  cwd = process.cwd(),
  runGit = defaultRunGit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  return resolveSha({
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    cwd,
    runGit,
    timeoutMs,
  });
}

export async function freezeCurrentOriginMain({
  cwd = process.cwd(),
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  runGit = defaultRunGit,
} = {}) {
  await runGit({
    args: [
      'fetch',
      '--no-tags',
      '--depth=1',
      'origin',
      '+refs/heads/main:refs/remotes/origin/main',
    ],
    cwd,
    timeoutMs: fetchTimeoutMs,
  });
  const baseSha = await resolveSha({
    args: ['rev-parse', '--verify', 'origin/main^{commit}'],
    cwd,
    runGit,
    timeoutMs: fetchTimeoutMs,
  });
  const headSha = await readCurrentHeadSha({ cwd, runGit, timeoutMs: fetchTimeoutMs });
  if (headSha !== baseSha) {
    throw new Error(
      `checkout is not the fetched current origin/main: checkout ${headSha}, origin/main ${baseSha}`
    );
  }
  return baseSha;
}
