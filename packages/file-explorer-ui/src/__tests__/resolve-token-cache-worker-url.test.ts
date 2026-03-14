import { describe, expect, it } from 'vitest';
import {
  resolveBackgroundIndexerWorkerUrlHref,
  resolveTokenCacheWorkerUrlHref,
} from '../resolve-token-cache-worker-url';

describe('resolve-token-cache-worker-url', () => {
  it('returns an app-owned token cache worker href', () => {
    expect(resolveTokenCacheWorkerUrlHref()).toContain('token-cache.worker');
  });

  it('returns an app-owned background indexer worker href', () => {
    expect(resolveBackgroundIndexerWorkerUrlHref()).toContain('background-indexer.worker');
  });
});
