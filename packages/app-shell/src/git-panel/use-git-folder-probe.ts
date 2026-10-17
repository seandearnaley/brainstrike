import { useEffect, useState } from 'react';
import {
  isTransientRootError,
  TRANSIENT_ROOT_RETRY_DELAY_MS,
  TRANSIENT_ROOT_RETRY_LIMIT,
} from '../roots/transient-root-error';
import type { GitResult, GitStatus } from './git-bridge';

/** What the folder switcher knows about one mounted root's Git state (BST-1897). */
export type GitFolderProbe =
  | { readonly kind: 'checking' }
  | { readonly branch: string | null; readonly kind: 'repository' }
  | { readonly kind: 'not-repository' }
  | { readonly error: string; readonly kind: 'error' };

const CHECKING: GitFolderProbe = { kind: 'checking' };

interface ProbeResults {
  /** The root list these results answer; results for an older list are never shown. */
  readonly key: string;
  readonly probes: ReadonlyMap<string, GitFolderProbe>;
}

function toProbe(result: GitResult<GitStatus>): GitFolderProbe {
  if (!result.ok) {
    return { error: result.error, kind: 'error' };
  }
  return result.value.isRepository
    ? { branch: result.value.branch, kind: 'repository' }
    : { kind: 'not-repository' };
}

/**
 * Reads Git status once for each listed root while the switcher is mounted, so
 * it can say which mounted roots are repositories. Only the workspace's own
 * mounted roots are read; no other path is scanned. A root whose row has not
 * reconciled yet is retried on the panel's transient-root budget, then reported
 * as an error rather than dropped.
 */
export function useGitFolderProbe(
  rootIds: readonly string[],
  probe: (rootId: string) => Promise<GitResult<GitStatus>>
): (rootId: string) => GitFolderProbe {
  const key = rootIds.join('\n');
  const [results, setResults] = useState<ProbeResults>({ key: '', probes: new Map() });

  useEffect(() => {
    if (key === '') {
      return;
    }
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const record = (rootId: string, value: GitFolderProbe): void => {
      if (cancelled) {
        return;
      }
      setResults((current) => {
        const probes = new Map(current.key === key ? current.probes : []);
        probes.set(rootId, value);
        return { key, probes };
      });
    };
    const run = (rootId: string, attempt: number): void => {
      probe(rootId)
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (
            !result.ok &&
            isTransientRootError(result.error) &&
            attempt < TRANSIENT_ROOT_RETRY_LIMIT
          ) {
            timers.add(setTimeout(() => run(rootId, attempt + 1), TRANSIENT_ROOT_RETRY_DELAY_MS));
            return;
          }
          record(rootId, toProbe(result));
        })
        .catch((error: unknown) => {
          record(rootId, {
            error: error instanceof Error ? error.message : String(error),
            kind: 'error',
          });
        });
    };
    for (const rootId of key.split('\n')) {
      run(rootId, 0);
    }
    return () => {
      cancelled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [key, probe]);

  return (rootId) => (results.key === key ? results.probes.get(rootId) : undefined) ?? CHECKING;
}
