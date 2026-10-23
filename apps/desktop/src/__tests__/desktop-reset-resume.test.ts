// @vitest-environment node
import {
  DEFAULT_INDEX_CONFIG,
  type IndexConfig,
} from '@brainstrike/assistant-contract/index-config';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopResetResume } from '../desktop-reset-resume';
import { createDesktopIndexConfig, IndexConfigStoreFailed } from '../index-config';

const CLOSED = new Error('The profile is closed for the reset.');

/** Main's config owner over a profile the reset closed; `resumeIndex` reopens it. */
function harness(reopened: IndexConfig | null = null) {
  let open = false;
  let readFailure: unknown = null;
  const publish = vi.fn<(config: IndexConfig) => void>();
  const indexConfig = createDesktopIndexConfig({
    assertModel: () => undefined,
    catalog: {
      collections: vi.fn(async () => ({ collections: [] })),
      indexConfig: vi.fn(async () => {
        if (!open) {
          throw CLOSED;
        }
        if (readFailure !== null) {
          throw readFailure;
        }
        return { config: reopened };
      }),
    },
    publish,
    rebuild: async () => undefined,
    reconfigure: async () => undefined,
    replaceVectorSpace: async () => undefined,
  });
  const resumeIndex = vi.fn(async (_signal: AbortSignal) => {
    open = true;
  });
  const resumeMcp = vi.fn(async (_outcome: 'failed' | 'succeeded') => undefined);
  const resume = createDesktopResetResume({
    publishIndexConfig: indexConfig.publishSaved,
    resumeIndex,
    resumeMcp,
  });
  return {
    failReads: (error: unknown) => {
      readFailure = error;
    },
    publish,
    resume,
    resumeIndex,
    resumeMcp,
  };
}

describe("Main's resume after a reset", () => {
  it("publishes the reopened profile's config once the profile reopens", async () => {
    const h = harness();
    await h.resume('succeeded', new AbortController().signal);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(DEFAULT_INDEX_CONFIG);
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('succeeded');
  });

  it('publishes the config the reopened profile holds, not the default', async () => {
    const saved: IndexConfig = { ...DEFAULT_INDEX_CONFIG, paused: true };
    const h = harness(saved);
    await h.resume('succeeded', new AbortController().signal);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it('publishes nothing after a failed reset: the profile kept its config', async () => {
    const h = harness();
    await h.resume('failed', new AbortController().signal);
    expect(h.resumeIndex).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('failed');
  });

  it('publishes nothing when the profile does not reopen, and rejects with why', async () => {
    const h = harness();
    const refused = new Error('The index could not reopen.');
    h.resumeIndex.mockRejectedValueOnce(refused);
    await expect(h.resume('succeeded', new AbortController().signal)).rejects.toBe(refused);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('rejects with the read failure when the reopened config cannot be read', async () => {
    const h = harness();
    const damaged = new Error('The config row is unreadable.');
    h.failReads(damaged);
    const failure = await h
      .resume('succeeded', new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(IndexConfigStoreFailed);
    expect(failure).toMatchObject({ cause: damaged });
    expect(h.publish).not.toHaveBeenCalled();
    // MCP resumes on its own: a config read does not hold the rest of the reopen.
    expect(h.resumeMcp).toHaveBeenCalledExactlyOnceWith('succeeded');
  });
});
