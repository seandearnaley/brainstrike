import { findActivePrByFingerprint, fingerprintMarker } from './active-pr-dedupe.mjs';
import { createBoundedExecFileRunner } from './isolated-worktree.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BRANCH_PATTERN = /^(?!main$)(?!refs\/heads\/main$)[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

function stdoutOf(result) {
  return typeof result === 'string' ? result : result.stdout;
}

export function createGitHubPrPublisher({ getCurrentBaseSha, repository, runGh, runGit }) {
  const boundedRunner = createBoundedExecFileRunner();
  const executeGh = runGh ?? (({ args, cwd }) => boundedRunner({ args, cwd, file: 'gh' }));
  const executeGit = runGit ?? (({ args, cwd }) => boundedRunner({ args, cwd, file: 'git' }));
  let proposedPrCount = 0;
  let publishing = false;

  async function assertCurrentBase(baseSha) {
    const currentBaseSha = await getCurrentBaseSha();
    if (!SHA_PATTERN.test(currentBaseSha) || currentBaseSha !== baseSha) {
      throw new Error(`stale frozen base: expected ${baseSha}, found ${currentBaseSha}`);
    }
  }

  return Object.freeze({
    async publish({ baseSha, body, branch, cwd, fingerprint, title }) {
      if (proposedPrCount >= 1 || publishing) {
        throw new Error('policy permits only one PR per run');
      }
      if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.endsWith('/')) {
        throw new Error('invalid or forbidden routine branch name');
      }
      publishing = true;
      try {
        await assertCurrentBase(baseSha);
        const duplicate = await findActivePrByFingerprint({
          fingerprint,
          repository,
          runGh: executeGh,
        });
        if (duplicate) {
          throw new Error(`active PR already exists for routine fingerprint: ${duplicate.url}`);
        }

        await assertCurrentBase(baseSha);
        await executeGit({
          args: ['push', 'origin', `HEAD:refs/heads/${branch}`],
          cwd,
        });
        const bodyWithMarker = `${body.trimEnd()}\n\n${fingerprintMarker(fingerprint)}\n`;
        const result = await executeGh({
          args: [
            'pr',
            'create',
            '--repo',
            repository,
            '--base',
            'main',
            '--head',
            branch,
            '--title',
            title,
            '--body',
            bodyWithMarker,
          ],
          cwd,
        });
        const prUrl = stdoutOf(result).trim();
        if (!URL.canParse(prUrl)) {
          throw new Error('GitHub returned an invalid PR URL');
        }
        proposedPrCount += 1;
        return prUrl;
      } finally {
        publishing = false;
      }
    },
  });
}
