import type { ProviderCredential } from '@brainstrike/assistant-contract';
import { useCallback } from 'react';
import { type CredentialSourceState, getSecretsCapability } from './provider-key-types';

type ToastFn = (options: {
  description: string;
  title: string;
  variant?: 'destructive';
}) => unknown;

interface CredentialMutationOptions {
  readonly notifySecretsChanged: () => void;
  readonly refresh: () => Promise<void>;
  /** Blocks every mutation until the source listing is trustworthy. */
  readonly sourceState: CredentialSourceState;
  readonly toast: ToastFn;
}

export interface CredentialMutations {
  /** Resolves true when the entry is gone (including when none existed). */
  readonly deleteSecret: (provider: string) => Promise<boolean>;
  /** Resolves true only when the credential was actually written. */
  readonly saveCredential: (provider: string, credential: ProviderCredential) => Promise<boolean>;
}

function describeSaveFailure(saveResult: unknown): string {
  const code = (saveResult as { error?: string } | null | undefined)?.error;
  if (code === 'encryption_unavailable') {
    return 'OS keychain encryption is unavailable on this system.';
  }
  if (code === 'malformed_credential') {
    // BST-1350 review, finding 1: the likeliest malformed field is the AWS
    // region, whose format is SECURITY-checked store-side (it becomes part
    // of the Bedrock request hostname).
    return 'The credential store rejected the credential as malformed. For Amazon Bedrock, the AWS region must be a plain region identifier like us-east-1.';
  }
  return 'Unknown error occurred while saving the key.';
}

/**
 * The keychain half of the Credential Inventory, shared by every row so slots
 * cannot drift in how they report failure.
 *
 * Saves go through the TYPED `saveCredential` bridge method exclusively —
 * there is deliberately no `saveKey` fallback: a preload without the typed
 * method fails visibly instead of silently dropping the save-time fingerprint
 * (NO SILENT FALLBACKS). Every failure is surfaced as a toast and leaves the
 * panel unchanged. `deleteKey` returning `false` is the deliberate exception:
 * it means there was nothing to remove, which is an idempotent success.
 * Row-level busy state is owned by the caller.
 */
export function useCredentialMutations({
  notifySecretsChanged,
  refresh,
  sourceState,
  toast,
}: CredentialMutationOptions): CredentialMutations {
  const saveCredential = useCallback(
    async (provider: string, credential: ProviderCredential): Promise<boolean> => {
      if (sourceState !== 'ready') {
        return false;
      }
      const saveFn = getSecretsCapability()?.saveCredential;
      if (!saveFn) {
        toast({
          description: 'Secure credential storage is unavailable.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
        return false;
      }

      let saveResult: unknown;
      try {
        saveResult = await saveFn(provider, credential);
      } catch {
        toast({
          description: 'The credential store rejected the save operation.',
          title: 'Failed to save key',
          variant: 'destructive',
        });
        return false;
      }
      if (saveResult !== true) {
        toast({
          description: describeSaveFailure(saveResult),
          title: 'Failed to save key',
          variant: 'destructive',
        });
        return false;
      }

      await refresh();
      notifySecretsChanged();
      return true;
    },
    [notifySecretsChanged, refresh, sourceState, toast]
  );

  const deleteSecret = useCallback(
    async (provider: string): Promise<boolean> => {
      if (sourceState !== 'ready') {
        return false;
      }
      const deleteKey = getSecretsCapability()?.deleteKey;
      if (!deleteKey) {
        toast({
          description: 'Secure credential storage is unavailable.',
          title: 'Failed to delete key',
          variant: 'destructive',
        });
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
        return false;
      }

      await refresh();
      notifySecretsChanged();
      return true;
    },
    [notifySecretsChanged, refresh, sourceState, toast]
  );

  return { deleteSecret, saveCredential };
}
