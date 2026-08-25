import { resolveWorktreesBridge } from '@brainstrike/app-shell/worktrees/availability';
import type { WorktreeSettingsStatus } from '@brainstrike/settings-ui/settings/system/worktree-settings-section';
import type { WorktreeSettings } from '@brainstrike/types';
import { useCallback, useEffect, useState } from 'react';

export interface UseWorktreeSettingsResult {
  readonly save: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }) => Promise<void>;
  readonly settings: WorktreeSettings | null;
  readonly status: WorktreeSettingsStatus;
}

/**
 * Renderer-side state for Settings → Workspace. The bridge is
 * capability-checked (absent in web / a broken preload), never gated by
 * `isElectron()`. A load or save failure surfaces the main-process message
 * verbatim — see `worktree-settings-section.tsx`'s no-silent-fallback
 * contract.
 */
export function useWorktreeSettings(): UseWorktreeSettingsResult {
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [status, setStatus] = useState<WorktreeSettingsStatus>({ kind: 'loading' });

  useEffect(() => {
    const bridge = resolveWorktreesBridge();
    if (!bridge) {
      setStatus({ kind: 'unavailable' });
      return;
    }
    let cancelled = false;
    bridge
      .getSettings()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.ok) {
          setSettings(result.value);
          setStatus({ kind: 'ready' });
        } else {
          setStatus({ kind: 'error', message: result.error });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (next: {
      readonly managedDirectory: string | null;
      readonly setupCommand: readonly string[] | null;
    }): Promise<void> => {
      const bridge = resolveWorktreesBridge();
      if (!bridge) {
        throw new Error('Worktrees are a desktop feature. This build has no worktree bridge.');
      }
      const result = await bridge.setSettings(next);
      if (!result.ok) {
        throw new Error(result.error);
      }
      setSettings(result.value);
    },
    []
  );

  return { save, settings, status };
}
