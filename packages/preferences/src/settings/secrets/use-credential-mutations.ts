import { useCallback } from 'react';
import type { CredentialSourceState } from './provider-key-types';

type ToastFn = (options: {
  description: string;
  title: string;
  variant?: 'destructive';
}) => unknown;

interface CredentialMutationOptions {
  readonly notifySecretsChanged: () => void;
  readonly refresh: () => Promise<void>;
  readonly setBusy: (busy: boolean) => void;
  /** Blocks every mutation until the source listing is trustworthy. */
  readonly sourceState: CredentialSourceState;
  readonly toast: ToastFn;
}

export interface CredentialMutations {
  /** Resolves true when the entry is gone (including when none existed). */
  readonly deleteSecret: (provider: string) => Promise<boolean>;
  /** Resolves true only when the key was actually written. */
  readonly saveSecret: (provider: string, rawKey: string) => Promise<boolean>;
}

function describeSaveFailure(saveResult: unknown): string {
  const code = (saveResult as { error?: string } | null | undefined)?.error;
  return code === 'encryption_unavailable'
    ? 'OS keychain encryption is unavailable on this system.'
    : 'Unknown error occurred while saving the key.';
}

/**
 * The keychain half of the API Keys panel, shared by the provider and Tavily
 * cards so the two cannot drift in how they report failure.
 *
 * Every failure is surfaced as a toast and leaves the panel unchanged — a
 * mutation never silently reports success. `deleteKey` returning `false` is
 * the deliberate exception: it means there was nothing to remove, which is an
 * idempotent success, not an error.
 */
export function useCredentialMutations({
  notifySecretsChanged,
  refresh,
  setBusy,
  sourceState,
  toast,
}: CredentialMutationOptions): CredentialMutations {
  const saveSecret = useCallback(
    async (provider: string, rawKey: string): Promise<boolean> => {
      const trimmedKey = rawKey.trim();
      if (!trimmedKey || sourceState !== 'ready') {
        return false;
      }
      const saveKey = window.secrets?.saveKey;
      setBusy(true);
      if (!saveKey) {
        toast({
          description: 'Secure credential storage is unavailable.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
        setBusy(false);
        return false;
      }

      let saveResult: unknown;
      try {
        saveResult = await saveKey(provider, trimmedKey);
      } catch {
        toast({
          description: 'The credential store rejected the save operation.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
        setBusy(false);
        return false;
      }
      if (saveResult !== true) {
        toast({
          description: describeSaveFailure(saveResult),
          title: 'Failed to save key',
          variant: 'destructive',
        });
        setBusy(false);
        return false;
      }

      await refresh();
      notifySecretsChanged();
      return true;
    },
    [notifySecretsChanged, refresh, setBusy, sourceState, toast]
  );

  const deleteSecret = useCallback(
    async (provider: string): Promise<boolean> => {
      if (sourceState !== 'ready') {
        return false;
      }
      const deleteKey = window.secrets?.deleteKey;
      setBusy(true);
      if (!deleteKey) {
        toast({
          description: 'Secure credential storage is unavailable.',
          title: 'Failed to delete key',
          variant: 'destructive',
        });
        setBusy(false);
        return false;
      }

      try {
        // `false` means "there was nothing to remove" — an idempotent success.
        // Only a THROWN error means the store refused or failed.
        await deleteKey(provider);
      } catch {
        toast({
          description: 'The credential store rejected the delete operation.',
          title: 'Failed to delete key',
          variant: 'destructive',
        });
        setBusy(false);
        return false;
      }

      await refresh();
      notifySecretsChanged();
      setBusy(false);
      return true;
    },
    [notifySecretsChanged, refresh, setBusy, sourceState, toast]
  );

  return { deleteSecret, saveSecret };
}
