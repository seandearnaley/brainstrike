/**
 * Settings › Workspace trust (ADR-0032): every mounted folder, whether the
 * person trusts it, and what trusting it loads. The composer asks once for a
 * folder that brings agent configuration; this panel changes the answer.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  describeWorkspaceAgentConfiguration,
  type WorkspaceTrustCapability,
  type WorkspaceTrustDecision,
  type WorkspaceTrustRoot,
} from './workspace-trust';

type ListState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly roots: readonly WorkspaceTrustRoot[] };

const TRUST_LABEL: Record<WorkspaceTrustRoot['trust'], string> = {
  restricted: 'Restricted',
  trusted: 'Trusted',
  undecided: 'Not trusted yet',
};

const TRUST_VARIANT: Record<WorkspaceTrustRoot['trust'], 'default' | 'secondary' | 'outline'> = {
  restricted: 'secondary',
  trusted: 'default',
  undecided: 'outline',
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export interface WorkspaceTrustSettingsSectionProps {
  /** The agent host's workspace trust; absent where no host owns folders (web). */
  readonly trust?: WorkspaceTrustCapability;
}

export function WorkspaceTrustSettingsSection({
  trust,
}: WorkspaceTrustSettingsSectionProps): React.JSX.Element {
  const [list, setList] = useState<ListState>(
    trust ? { kind: 'loading' } : { kind: 'ready', roots: [] }
  );
  const [generation, setGeneration] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!trust) {
      return;
    }
    let cancelled = false;
    trust
      .listTrust()
      .then((roots) => {
        if (!cancelled) {
          setList({ kind: 'ready', roots });
        }
      })
      .catch((error: unknown) => {
        // A failed read is its own state: never an empty list, which would
        // claim no folder is mounted.
        if (!cancelled) {
          setList({
            kind: 'error',
            message: errorMessage(error, 'Workspace trust is unreadable'),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [trust, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  const decide = async (root: WorkspaceTrustRoot, decision: WorkspaceTrustDecision) => {
    if (!trust) {
      return;
    }
    setBusyPath(root.path);
    try {
      await trust.setTrust(root.path, decision);
      setActionError(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, 'The agent host refused the change'));
    }
    setBusyPath(null);
    reload();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace trust</CardTitle>
        <CardDescription>
          A folder’s <code>AGENTS.md</code>, skills, slash commands and subagents can steer the
          assistant, so Brainstrike loads them only from folders you trust. A folder you haven’t
          trusted still works: the assistant can read and edit it under your permission settings.
          Project hooks keep their own approval in Hooks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.kind === 'loading' ? (
          <p className="text-muted-foreground text-sm">Checking folders…</p>
        ) : null}
        {list.kind === 'error' ? (
          <div className="flex items-center justify-between gap-4" role="alert">
            <p className="text-destructive text-sm">{list.message}</p>
            <Button onClick={reload} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {list.kind === 'ready' && list.roots.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="workspace-trust-no-roots">
            No folders are open. Open a folder to choose whether to trust it.
          </p>
        ) : null}
        {list.kind === 'ready' && list.roots.length > 0 ? (
          <ul className="space-y-3">
            {list.roots.map((root) => {
              const holds = describeWorkspaceAgentConfiguration(root.agentConfiguration);
              const busy = busyPath === root.path;
              return (
                <li
                  className="flex items-center justify-between gap-4 rounded-md border p-3"
                  data-testid={`workspace-trust-root-${root.rootId}`}
                  key={root.rootId}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{root.displayName}</span>
                      <Badge variant={TRUST_VARIANT[root.trust]}>{TRUST_LABEL[root.trust]}</Badge>
                    </div>
                    <p className="text-muted-foreground truncate text-xs">{root.path}</p>
                    <p className="text-muted-foreground text-xs">
                      {holds ? `Holds ${holds}.` : 'Holds no agent configuration.'}
                    </p>
                  </div>
                  {root.trust === 'trusted' ? (
                    <Button
                      disabled={busy}
                      onClick={() => void decide(root, 'restricted')}
                      size="sm"
                      variant="outline"
                    >
                      Restrict
                    </Button>
                  ) : (
                    <Button disabled={busy} onClick={() => void decide(root, 'trusted')} size="sm">
                      Trust
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
        {actionError ? (
          <p className="text-destructive text-sm" role="alert">
            {actionError}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
