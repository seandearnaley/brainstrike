// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createDesktopResetResume } from '../desktop-reset-resume';

function harness() {
  const resumeProfile = vi.fn(async (_signal: AbortSignal) => undefined);
  const resumeMcp = vi.fn(async (_outcome: 'failed' | 'succeeded') => undefined);
  return {
    resume: createDesktopResetResume({ resumeMcp, resumeProfile }),
    resumeMcp,
    resumeProfile,
  };
}

describe("Main's resume after a reset", () => {
  it('reopens the profile a successful reset left, then resumes MCP', async () => {
    const h = harness();
    await h.resume('succeeded', new AbortController().signal);
    expect(h.resumeProfile).toHaveBeenCalledOnce();
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('succeeded');
    expect(h.resumeProfile.mock.invocationCallOrder[0]).toBeLessThan(
      h.resumeMcp.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('resumes only MCP after a failed reset: the profile kept its content', async () => {
    const h = harness();
    await h.resume('failed', new AbortController().signal);
    expect(h.resumeProfile).not.toHaveBeenCalled();
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('rejects with why when the profile does not reopen', async () => {
    const h = harness();
    const refused = new Error('The host could not start.');
    h.resumeProfile.mockRejectedValueOnce(refused);
    await expect(h.resume('succeeded', new AbortController().signal)).rejects.toBe(refused);
    expect(h.resumeMcp).not.toHaveBeenCalled();
  });
});
