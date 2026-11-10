/**
 * Settings › Workspace Trust (ADR-0032): each answer behind the mounted
 * folders, whether the person trusts it, and what trusting it loads. A
 * repository and its worktrees share one answer, so they are one row. The
 * composer asks once for a folder that brings agent configuration; this panel
 * changes the answer.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorNotice,
} from '@brainstrike/ui';
import { useEffect, useState } from 'react';
import {
  describeWorkspaceAgentConfiguration,
  type WorkspaceTrustAnswer,
  type WorkspaceTrustCapability,
  type WorkspaceTrustDecision,
  type WorkspaceTrustRoot,
  workspaceTrustAnswers,
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

/** "AGENTS.md and 2 skills", or that the folder holds none. */
const holdings = (root: WorkspaceTrustRoot): string =>
  describeWorkspaceAgentConfiguration(root.agentConfiguration) || 'no agent configuration';

/** One answer: the folder it is recorded for, what it loads, and the worktrees that share it. */
function AnswerRow({
  answer,
  busy,
  onDecide,
}: {
  readonly answer: WorkspaceTrustAnswer;
  readonly busy: boolean;
  readonly onDecide: (answer: WorkspaceTrustAnswer, decision: WorkspaceTrustDecision) => void;
}): React.JSX.Element {
  // The answering folder's own entry: absent while only its worktrees are open.
  const own = answer.roots.find((root) => root.answeredBy === undefined);
  const worktrees = answer.roots.filter((root) => root.answeredBy !== undefined);
  return (
    <li
      className="flex items-center justify-between gap-4 rounded-md border p-3"
      data-testid={`workspace-trust-root-${(own ?? answer.roots[0])?.rootId}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{answer.displayName}</span>
          <Badge variant={TRUST_VARIANT[answer.trust]}>{TRUST_LABEL[answer.trust]}</Badge>
        </div>
        <p className="text-muted-foreground truncate text-xs">{answer.path}</p>
        {own ? <p className="text-muted-foreground text-xs">Holds {holdings(own)}.</p> : null}
        {worktrees.length > 0 ? (
          <div className="text-muted-foreground text-xs">
            <p>Its worktrees share this answer:</p>
            <ul className="list-disc pl-4">
              {worktrees.map((worktree) => (
                <li key={worktree.rootId}>
                  <span className="font-medium">{worktree.displayName}</span> holds{' '}
                  {holdings(worktree)}.
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {answer.trust === 'trusted' ? (
        <Button
          disabled={busy}
          onClick={() => onDecide(answer, 'restricted')}
          size="sm"
          variant="outline"
        >
          Restrict
        </Button>
      ) : (
        <Button disabled={busy} onClick={() => onDecide(answer, 'trusted')} size="sm">
          Trust
        </Button>
      )}
    </li>
  );
}

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

  const reload = () => setGeneration((value) => value + 1);

  // An answer is given for the folder it is recorded for: the repository, not one of its worktrees.
  const decide = async (answer: WorkspaceTrustAnswer, decision: WorkspaceTrustDecision) => {
    if (!trust) {
      return;
    }
    setBusyPath(answer.path);
    try {
      await trust.setTrust(answer.path, decision);
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
        <CardTitle>Trusted folders</CardTitle>
        <CardDescription>
          A folder’s <code>AGENTS.md</code>, skills, slash commands and subagents can steer the
          assistant, so Brainstrike loads them only from folders you trust. A folder you haven’t
          trusted still works: the assistant can read and edit it under your permission settings. A
          repository’s worktrees share its answer. Project hooks keep their own approval in Hooks.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.kind === 'loading' ? (
          <p className="text-muted-foreground text-sm">Checking folders…</p>
        ) : null}
        {list.kind === 'error' ? <ErrorNotice message={list.message} onRetry={reload} /> : null}
        {list.kind === 'ready' && list.roots.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="workspace-trust-no-roots">
            No folders are open. Open a folder to choose whether to trust it.
          </p>
        ) : null}
        {list.kind === 'ready' && list.roots.length > 0 ? (
          <ul className="space-y-3">
            {workspaceTrustAnswers(list.roots).map((answer) => (
              <AnswerRow
                answer={answer}
                busy={busyPath === answer.path}
                key={answer.path}
                onDecide={(target, decision) => void decide(target, decision)}
              />
            ))}
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
