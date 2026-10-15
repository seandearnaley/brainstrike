// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  resolveBackgroundIndexerWorkerUrlHref,
  resolveTokenCacheWorkerUrlHref,
} from '../indexing/resolve-token-cache-worker-url';

describe('resolve-token-cache-worker-url', () => {
  it('returns an app-owned token cache worker href', () => {
    expect(resolveTokenCacheWorkerUrlHref()).toContain('token-cache.worker');
  });

  it('returns an app-owned background indexer worker href', () => {
    expect(resolveBackgroundIndexerWorkerUrlHref()).toContain('background-indexer.worker');
  });
});
