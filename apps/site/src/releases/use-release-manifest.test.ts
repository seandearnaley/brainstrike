import { describe, expect, it } from 'vitest';
import type { ReleaseManifest } from './release-manifest';
import { manifestRequestFailureState, type ReleaseManifestState } from './use-release-manifest';

const MANIFEST: ReleaseManifest = {
  channel: 'stable',
  distribution: null,
  latest: null,
  product: 'Brainstrike',
  schemaVersion: 2,
};

describe('manifestRequestFailureState', () => {
  it('retains a validated manifest when background revalidation fails', () => {
    const ready: ReleaseManifestState = { manifest: MANIFEST, status: 'ready' };

    expect(manifestRequestFailureState(ready, new Error('HTTP 503'), false)).toEqual({
      manifest: MANIFEST,
      status: 'ready',
      warning: 'Release refresh failed: HTTP 503',
    });
  });

  it('surfaces an initial request failure as a terminal error', () => {
    expect(manifestRequestFailureState({ status: 'loading' }, new Error('offline'), true)).toEqual({
      error: 'offline',
      status: 'error',
    });
  });
});
