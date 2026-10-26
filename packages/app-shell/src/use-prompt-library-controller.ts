import type { PromptItem, PromptItemRepositoryPort } from '@brainstrike/types/prompt-item';
import { useEffect, useState } from 'react';

type PromptManagerReadiness =
  | { readonly status: 'loading' }
  | {
      readonly error: string;
      readonly repository: PromptItemRepositoryPort;
      readonly status: 'error';
    }
  | {
      readonly items: readonly PromptItem[];
      readonly repository: PromptItemRepositoryPort;
      readonly status: 'ready';
    };

interface UsePromptLibraryControllerOptions {
  readonly repository: PromptItemRepositoryPort;
}

export interface PromptLibraryController {
  readonly readiness: PromptManagerReadiness;
}

export function toPromptWorkbenchErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : `Unexpected Prompt Workbench failure: ${String(error)}`;
}

export function usePromptLibraryController({
  repository,
}: UsePromptLibraryControllerOptions): PromptLibraryController {
  const [readiness, setReadiness] = useState<PromptManagerReadiness>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    void repository
      .list()
      .then((items) => {
        if (current) {
          setReadiness({ items, repository, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setReadiness({
            error: toPromptWorkbenchErrorMessage(error),
            repository,
            status: 'error',
          });
        }
      });
    return () => {
      current = false;
    };
  }, [repository]);

  return { readiness };
}
