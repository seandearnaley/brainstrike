import { createLogger } from '@brainstrike/utils';
import { useEffect, useState } from 'react';

const logger = createLogger('HookTrustScope');

/**
 * Resolve the DB `roots.id`s of the currently-mounted workspace roots so the
 * hook-trust attestation can be SCOPED to them (a disconnected root's grant must
 * never be presented to the assistant server). Extracted from the assistant
 * panel wrapper so the fail-closed timing is unit-testable.
 *
 * Fail-closed contract:
 * - Disabled (non-desktop transport) → returns `null` (the caller treats a
 *   null/empty scope as "attest nothing").
 * - Invalidation happens IN RENDER: the resolved set is keyed to the descriptor
 *   identity it was computed FOR, and the hook returns empty whenever the
 *   current descriptors don't match that key. The very render triggered by a
 *   root change (or disconnect) therefore already returns an empty scope — an
 *   effect-set clear would land one render too late, and a request prepared in
 *   that render would still attest the disconnected root. The async resolution
 *   then repopulates.
 * - Resolver bridge absent → attest nothing.
 * - Resolver rejection (startup DB-not-ready / IPC blip) → stay empty, warn, and
 *   retry ONCE after a short delay; never poll unbounded.
 */

const HOOK_TRUST_RESOLVE_RETRY_MS = 500;

const EMPTY_TRUST_SCOPE: ReadonlySet<string> = new Set();

interface ResolveTrustedRootIdsBridge {
  resolveTrustedRootIds?: (
    paths: readonly string[]
  ) => Promise<ReadonlyArray<{ dbRootId: string; path: string }>>;
}

export interface UseHookTrustScopeParams {
  /** True only for the desktop data-stream transport (the sole hook consumer). */
  readonly enabled: boolean;
  /**
   * rootId → descriptor for the currently-mounted workspace roots. Must be
   * identity-stable across renders (a store slice) — the resolved scope is
   * keyed to this object's identity, and a fresh literal per render would both
   * pin the scope to empty and re-run the resolution effect on every render.
   */
  readonly rootDescriptors: Readonly<Record<string, { path?: string | null }>> | undefined;
}

interface ResolvedTrustScope {
  /** The descriptor identity this scope was resolved FOR (render-time key). */
  readonly forDescriptors: UseHookTrustScopeParams['rootDescriptors'];
  readonly rootIds: ReadonlySet<string>;
}

export function useHookTrustScope({
  enabled,
  rootDescriptors,
}: UseHookTrustScopeParams): ReadonlySet<string> | null {
  const [resolved, setResolved] = useState<ResolvedTrustScope | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const bridge = (window as Window & { hooks?: ResolveTrustedRootIdsBridge }).hooks;
    if (!bridge?.resolveTrustedRootIds) {
      // No resolver → nothing ever resolves for this identity → the render
      // derivation keeps returning empty (fail closed).
      return;
    }
    const resolveTrustedRootIds = bridge.resolveTrustedRootIds;
    const paths = Object.values(rootDescriptors ?? {})
      .map((descriptor) => descriptor.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
    let ignore = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const resolve = (canRetry: boolean): void => {
      resolveTrustedRootIds(paths)
        .then((entries) => {
          if (!ignore) {
            setResolved({
              forDescriptors: rootDescriptors,
              rootIds: new Set(entries.map((entry) => entry.dbRootId)),
            });
          }
        })
        .catch((error: unknown) => {
          if (ignore) {
            return;
          }
          // Stay fail-closed (the derivation returns empty for an unresolved
          // identity) and surface the failure. Retry ONCE after a short delay to
          // ride out a startup DB-not-ready / IPC blip; never poll unbounded.
          logger.warn('Failed to resolve trusted hook root ids; attesting nothing', {
            error,
            willRetry: canRetry,
          });
          if (canRetry) {
            retryTimer = setTimeout(() => {
              if (!ignore) {
                resolve(false);
              }
            }, HOOK_TRUST_RESOLVE_RETRY_MS);
          }
        });
    };
    resolve(true);
    return () => {
      ignore = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [enabled, rootDescriptors]);
  if (!enabled) {
    return null;
  }
  // Render-time derivation: only a scope resolved for EXACTLY these descriptors
  // is trusted; anything else (never resolved, or resolved for a previous root
  // set) is empty. This is what makes a root disconnect fail closed in the same
  // render that observes it.
  return resolved !== null && resolved.forDescriptors === rootDescriptors
    ? resolved.rootIds
    : EMPTY_TRUST_SCOPE;
}
