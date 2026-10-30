import { hasFactoryResetPreparationStarted } from '@brainstrike/app-state/factory-reset';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import {
  describeWorkspaceAgentConfiguration,
  type WorkspaceTrustDecision,
  type WorkspaceTrustRoot,
  workspaceAgentConfigurationParts,
} from '@brainstrike/settings-ui/settings/system/workspace-trust';
import { Button } from '@brainstrike/ui';
import { ShieldQuestion } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useAssistantThreadHost } from '../assistant-thread-host-context';
import { useWorkspaceTrustRevision } from './workspace-trust-revision';

const logger = createLogger('WorkspaceTrustPrompt');

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

/** A folder the person has not answered for, which brings agent configuration. */
function asksForTrust(root: WorkspaceTrustRoot): boolean {
  return (
    root.trust === 'undecided' &&
    workspaceAgentConfigurationParts(root.agentConfiguration).length > 0
  );
}

/**
 * ADR-0032: VS Code's Restricted Mode banner, above the composer. Each mounted
 * folder that holds instructions, skills, slash commands or subagents and has
 * no answer yet says what it holds, and asks once. Nothing waits on it: until
 * the person trusts the folder, runs leave its agent configuration out.
 */
export function WorkspaceTrustPrompt(): ReactElement | null {
  const discovery = useAssistantThreadHost()?.workspaceDiscovery;
  // Reload triggers only: a folder added or removed, or an answer given anywhere.
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const revision = useWorkspaceTrustRevision();
  const [roots, setRoots] = useState<readonly WorkspaceTrustRoot[]>([]);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Last requested wins: a slow older read never replaces a fresher one.
  const generationRef = useRef(0);

  useEffect(() => {
    if (!discovery || hasFactoryResetPreparationStarted()) {
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    discovery
      .listTrust()
      .then((result) => {
        if (generation === generationRef.current) {
          setRoots(result);
        }
      })
      .catch((error: unknown) => {
        // The reset stops the host under a read it overtook (ADR-0015).
        if (!hasFactoryResetPreparationStarted()) {
          logger.error('Failed to read workspace trust', { error });
        }
      });
    return () => {
      generationRef.current += 1;
    };
  }, [discovery, activeRootIds, revision]);

  const asking = roots.filter(asksForTrust);
  if (!discovery || asking.length === 0) {
    return null;
  }

  // The host records the answer; the revision it bumps reloads this list and the "/" menu.
  const decide = async (root: WorkspaceTrustRoot, decision: WorkspaceTrustDecision) => {
    setBusyPath(root.path);
    try {
      await discovery.setTrust(root.path, decision);
      setActionError(null);
    } catch (error: unknown) {
      setActionError(errorMessage(error, 'The agent host refused the change'));
    }
    setBusyPath(null);
  };

  return (
    <section aria-label="Workspace trust" className="space-y-2 px-3 pb-2">
      {asking.map((root) => (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
          data-testid={`workspace-trust-prompt-${root.rootId}`}
          key={root.rootId}
        >
          <ShieldQuestion aria-hidden className="size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">Trust the files in {root.displayName}?</p>
            <p className="text-muted-foreground">
              This folder has {describeWorkspaceAgentConfiguration(root.agentConfiguration)}, which
              can steer the assistant. Brainstrike loads them only from folders you trust.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={busyPath === root.path}
              onClick={() => void decide(root, 'trusted')}
              size="sm"
            >
              Trust folder
            </Button>
            <Button
              disabled={busyPath === root.path}
              onClick={() => void decide(root, 'restricted')}
              size="sm"
              variant="outline"
            >
              Keep restricted
            </Button>
          </div>
        </div>
      ))}
      {actionError ? (
        <p className="text-destructive text-sm" role="alert">
          {actionError}
        </p>
      ) : null}
    </section>
  );
}
