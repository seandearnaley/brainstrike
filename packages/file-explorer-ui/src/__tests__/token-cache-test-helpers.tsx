import type { ReactNode } from 'react';
import { TokenCacheProvider } from '../indexing/token-cache-context';
import { FileExplorerTestWrapper } from './test-helpers';

/**
 * Factory for a FileExplorerTestWrapper nested inside a TokenCacheProvider
 * (db=null — in-memory store, no PGlite needed). Used by tests asserting
 * that a token-cache-driven re-render (e.g. worker warmup flipping
 * isOperational) does not itself change unrelated consumers' memoized
 * values.
 *
 * Deliberately NOT in test-helpers.tsx: that file is imported by every test
 * in this package, and importing `token-cache-context` from it drags
 * `@brainstrike/db`, `@brainstrike/token-cache/cache-runtime`
 * (FileHasher/xxhash-wasm, TokenCacheStore), and the Vite `?worker&url`
 * worker-URL imports into every test file's module graph — none of which
 * `FileExplorerTestWrapper` itself needs. Only the (currently one) test that
 * actually mounts a TokenCacheProvider should import this module.
 */
export function createTokenCacheTestWrapper() {
  return function TokenCacheTestWrapper({ children }: { children?: ReactNode }) {
    return (
      <TokenCacheProvider db={null}>
        <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
      </TokenCacheProvider>
    );
  };
}
