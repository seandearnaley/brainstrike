import { useWorktreesBridge } from '@brainstrike/app-shell/workspace-git-services';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { WorktreeSettingsStatus } from '@brainstrike/settings-ui/settings/system/worktree-settings-section';
import type { WorktreeSetupConsents } from '@brainstrike/settings-ui/settings/system/worktree-setup-consent-settings-section';
import type { WorktreeSettings, WorktreeSetupCommand } from '@brainstrike/types';
import { useEffect, useMemo, useState } from 'react';

export interface UseWorktreeSettingsResult {
  readonly save: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }) => Promise<void>;
  readonly settings: WorktreeSettings | null;
  /** The host's setup script answers (ADR-0034); undefined without a worktree host. */
  readonly setupConsent: WorktreeSetupConsents | undefined;
  readonly status: WorktreeSettingsStatus;
}

/**
 * Renderer-side state for Settings → Workspace. The bridge is
 * capability-checked (absent when the host serves no worktrees), never gated
 * by `isElectron()`. A load or save failure surfaces the host's message
 * verbatim — see `worktree-settings-section.tsx`'s no-silent-fallback
 * contract.
 */
export function useWorktreeSettings(): UseWorktreeSettingsResult {
  const bridge = useWorktreesBridge();
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [status, setStatus] = useState<WorktreeSettingsStatus>(
    bridge ? { kind: 'loading' } : { kind: 'unavailable' }
  );

  useEffect(() => {
    if (!bridge) {
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
          setStatus({ kind: 'error', message: describeBoundaryFailure(result.error) });
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
  }, [bridge]);

  const save = async (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  }): Promise<void> => {
    if (!bridge) {
      throw new Error('Worktrees are unavailable in this window.');
    }
    const result = await bridge.setSettings(next);
    if (!result.ok) {
      throw new BoundaryFailureError(result.error);
    }
    setSettings(result.value);
  };

  // One object per bridge: the section rereads whenever it changes.
  const setupConsent = useMemo<WorktreeSetupConsents | undefined>(
    () =>
      bridge
        ? {
            list: async () => {
              const result = await bridge.listSetupConsent();
              if (!result.ok) {
                throw new BoundaryFailureError(result.error);
              }
              return result.value;
            },
            revoke: async (repositoryId) => {
              const result = await bridge.revokeSetupConsent({ repositoryId });
              if (!result.ok) {
                throw new BoundaryFailureError(result.error);
              }
            },
          }
        : undefined,
    [bridge]
  );

  return { save, settings, setupConsent, status };
}
