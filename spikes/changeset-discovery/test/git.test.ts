import { describe, expect, it } from 'vitest';
import { runGit } from '../src/git.ts';

describe('runGit', () => {
  it('returns stdout for a successful command', async () => {
    const out = await runGit(process.cwd(), ['--version']);
    expect(out).toMatch(/^git version /);
  });

  it('throws with stderr detail on failure', async () => {
    await expect(
      runGit(process.cwd(), ['rev-parse', '--verify', 'no-such-ref-xyz'])
    ).rejects.toThrow();
  });
});
