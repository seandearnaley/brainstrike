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
 * - Every resolution starts by CLEARING the scope synchronously, so a root
 *   change (or disconnect) fails closed IMMEDIATELY — the previous scope never
 *   lingers across the async DB-id resolution window.
 * - Resolver bridge absent → attest nothing.
 * - Resolver rejection (startup DB-not-ready / IPC blip) → stay empty, warn, and
 *   retry ONCE after a short delay; never poll unbounded.
 */

const HOOK_TRUST_RESOLVE_RETRY_MS = 500;

interface ResolveTrustedRootIdsBridge {
  resolveTrustedRootIds?: (
    paths: readonly string[]
  ) => Promise<ReadonlyArray<{ dbRootId: string; path: string }>>;
}

export interface UseHookTrustScopeParams {
  /** True only for the desktop data-stream transport (the sole hook consumer). */
  readonly enabled: boolean;
  /** rootId → descriptor for the currently-mounted workspace roots. */
  readonly rootDescriptors: Readonly<Record<string, { path?: string | null }>> | undefined;
}

export function useHookTrustScope({
  enabled,
  rootDescriptors,
}: UseHookTrustScopeParams): ReadonlySet<string> | null {
  const [mountedTrustRootIds, setMountedTrustRootIds] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMountedTrustRootIds(null);
      return;
    }
    // Fail closed IMMEDIATELY: a root change (or disconnect) must drop the prior
    // scope synchronously, before the async DB-id resolution settles — otherwise
    // a disconnected root's grant would still be attested during that window.
    setMountedTrustRootIds(new Set());
    const bridge = (window as Window & { hooks?: ResolveTrustedRootIdsBridge }).hooks;
    if (!bridge?.resolveTrustedRootIds) {
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
            setMountedTrustRootIds(new Set(entries.map((entry) => entry.dbRootId)));
          }
        })
        .catch((error: unknown) => {
          if (ignore) {
            return;
          }
          // Stay fail-closed (already empty) and surface the failure. Retry ONCE
          // after a short delay to ride out a startup DB-not-ready / IPC blip;
          // never poll unbounded.
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
  return mountedTrustRootIds;
}
