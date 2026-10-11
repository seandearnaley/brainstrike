import './_windows-command-fixture';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import type { GitCommandRunner } from '../../assistant-server/git-service';
import {
  execFileSnapshotGitRunner,
  type SnapshotGitCommandRunner,
} from '../../assistant-server/snapshot-git';
import { execFileGitRunner } from '../../git-ipc-handlers';

const execFileAsync = promisify(execFile);
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'bs-git-fixture-config-'));
const fixtureConfigPath = join(fixtureDirectory, 'config');
afterAll(() => rm(fixtureDirectory, { force: true, recursive: true }));
writeFileSync(fixtureConfigPath, '[core]\nlongpaths = true\n');

// Windows qualification inherited system autocrlf/symlink settings. Pass owned
// config explicitly: production runners intentionally scrub inherited GIT_*.
// Repository-local configuration and the product's safety pins remain intact.
// Git for Windows rejects Node's device path; its config input is a real file.
const fixtureConfig = {
  GIT_CONFIG_GLOBAL: fixtureConfigPath,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: fixtureConfigPath,
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
