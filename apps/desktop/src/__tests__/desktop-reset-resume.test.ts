import { describe, expect, it, vi } from 'vitest';
import { createDesktopResetResume } from '../desktop-reset-resume';

function harness() {
  const resumeProfile = vi.fn(async (_signal: AbortSignal): Promise<void> => undefined);
  const resumeMcp = vi.fn(async (_outcome: 'failed' | 'succeeded') => undefined);
  return {
    resume: createDesktopResetResume({ resumeMcp, resumeProfile }),
    resumeMcp,
    resumeProfile,
  };
}

describe("Main's resume after a reset", () => {
  it('reopens the reset profile, then MCP', async () => {
    const h = harness();
    await h.resume('succeeded', new AbortController().signal);
    expect(h.resumeProfile).toHaveBeenCalledOnce();
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('succeeded');
  });

  it('keeps the profile open after a failed reset and resumes MCP', async () => {
    const h = harness();
    await h.resume('failed', new AbortController().signal);
    expect(h.resumeProfile).not.toHaveBeenCalled();
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('rejects with why the profile did not reopen', async () => {
    const h = harness();
    const refused = new Error('The agent host could not start.');
    h.resumeProfile.mockRejectedValueOnce(refused);
    await expect(h.resume('succeeded', new AbortController().signal)).rejects.toBe(refused);
    expect(h.resumeMcp).not.toHaveBeenCalled();
  });

  it('resumes nothing more once quit cancelled the reopen', async () => {
    const h = harness();
    const quit = new AbortController();
    h.resumeProfile.mockImplementationOnce(async () => quit.abort());
    await expect(h.resume('succeeded', quit.signal)).rejects.toBe(quit.signal.reason);
    expect(h.resumeMcp).not.toHaveBeenCalled();
  });
});
