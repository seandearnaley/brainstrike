import { execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { promisify } from 'node:util';
import type { GitCommandRunner } from '../../assistant-server/git-service';
import {
  execFileSnapshotGitRunner,
  type SnapshotGitCommandRunner,
} from '../../assistant-server/snapshot-git';
import { execFileGitRunner } from '../../git-ipc-handlers';

const execFileAsync = promisify(execFile);

// Windows qualification inherited system autocrlf/symlink settings. Pass owned
// config explicitly: production runners intentionally scrub inherited GIT_*.
// Repository-local configuration and the product's safety pins remain intact.
const fixtureConfig = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull,
};

export function execFixtureGit(
  args: readonly string[],
  options: { readonly cwd: string }
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', [...args], {
    ...options,
    env: { ...process.env, ...fixtureConfig },
  });
}

export const fixtureGitRunner: GitCommandRunner = (params) =>
  execFileGitRunner({ ...params, env: { ...fixtureConfig, ...params.env } });

export const fixtureSnapshotGitRunner: SnapshotGitCommandRunner = (params) =>
  execFileSnapshotGitRunner({ ...params, env: { ...fixtureConfig, ...params.env } });
