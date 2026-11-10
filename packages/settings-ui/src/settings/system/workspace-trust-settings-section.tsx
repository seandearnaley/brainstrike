/**
 * Settings › Workspace Trust (ADR-0032): each answer behind the mounted
 * folders, whether the person trusts it, and what trusting it loads. A
 * repository and its worktrees share one answer, so they are one row. The
 * composer asks once for a folder that brings agent configuration; this panel
 * changes the answer. It also lists the trusted locations, inside which every
 * folder is trusted without an ask, says which folders are trusted through
 * one, and removes them.
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  ErrorNotice,
} from '@brainstrike/ui';
import { useEffect, useId, useState } from 'react';
import {
  describeWorkspaceAgentConfiguration,
  type WorkspaceTrustAnswer,
  type WorkspaceTrustCapability,
  type WorkspaceTrustDecision,
  type WorkspaceTrustedLocation,
  type WorkspaceTrustRoot,
  workspaceTrustAnswers,
} from './workspace-trust';

/** The folders and the locations are read together, so the panel never shows half of an answer. */
type ListState =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly locations: readonly WorkspaceTrustedLocation[];
      readonly roots: readonly WorkspaceTrustRoot[];
    };

/** Why the host refused the last change, shown in the card the change was made in. */
interface ActionError {
  readonly card: 'folders' | 'locations';
  readonly message: string;
}

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

type Decide = (
  answer: WorkspaceTrustAnswer,
  decision: WorkspaceTrustDecision,
  location?: string
) => void;

/**
 * One answer: the folder it is recorded for, what it loads, the worktrees that
 * share it, and the trusted location it comes from when the person gave none.
 */
function AnswerRow({
  answer,
  busy,
  onDecide,
}: {
  readonly answer: WorkspaceTrustAnswer;
  readonly busy: boolean;
  readonly onDecide: Decide;
}): React.JSX.Element {
  const parentBoxId = useId();
  // Unticked until the person ticks it: trusting a folder never widens to its parent by itself.
  const [alsoParent, setAlsoParent] = useState(false);
  // The answering folder's own entry: absent while only its worktrees are open.
  const own = answer.roots.find((root) => root.answeredBy === undefined);
  const worktrees = answer.roots.filter((root) => root.answeredBy !== undefined);
  const { offeredLocation } = answer;
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
        {answer.trustedThrough ? (
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
            Trusted because it is in the trusted location{' '}
            <span className="font-medium">{answer.trustedThrough}</span>.
          </p>
        ) : null}
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
        {answer.trust !== 'trusted' && offeredLocation ? (
          <div className="flex items-start gap-2 pt-1 text-xs">
            <Checkbox
              checked={alsoParent}
              className="mt-0.5"
              disabled={busy}
              id={parentBoxId}
              onCheckedChange={(next) => setAlsoParent(next === true)}
            />
            <label className="[overflow-wrap:anywhere]" htmlFor={parentBoxId}>
              Also trust every folder in <span className="font-medium">{offeredLocation}</span>
            </label>
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
        <Button
          disabled={busy}
          // The parent is trusted only with the folder, and only when its box is ticked.
          onClick={() =>
            offeredLocation && alsoParent
              ? onDecide(answer, 'trusted', offeredLocation)
              : onDecide(answer, 'trusted')
          }
          size="sm"
        >
          Trust
        </Button>
      )}
    </li>
  );
}

/** The trusted locations, each with its removal. */
function LocationsCard({
  actionError,
  busyPath,
  locations,
  onRemove,
}: {
  readonly actionError: string | null;
  readonly busyPath: string | null;
  /** Undefined until the lists are read; a failed read is reported with the folders. */
  readonly locations: readonly WorkspaceTrustedLocation[] | undefined;
  readonly onRemove: (location: WorkspaceTrustedLocation) => void;
}): React.JSX.Element {
  return (
    <Card data-testid="workspace-trust-locations">
      <CardHeader>
        <CardTitle>Trusted locations</CardTitle>
        <CardDescription>
          Every folder in a trusted location is trusted without asking, including one put there
          later, so keep these to places that hold your own work. A folder you restrict stays
          restricted. To add one, tick “Also trust every folder in…” when you trust a folder.
          Removing one keeps the answers you gave for folders; a folder trusted only through it asks
          again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {locations?.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="workspace-trust-no-locations">
            No trusted locations.
          </p>
        ) : null}
        {locations && locations.length > 0 ? (
          <ul aria-label="Trusted locations" className="space-y-2">
            {locations.map((location) => (
              <li
                className="flex items-center justify-between gap-4 rounded-md border p-3"
                data-testid={`workspace-trust-location-${location.path}`}
                key={location.path}
              >
                <p className="min-w-0 font-mono text-xs break-all">{location.path}</p>
                <Button
                  aria-label={`Remove ${location.path}`}
                  disabled={busyPath === location.path}
                  onClick={() => onRemove(location)}
                  size="sm"
                  variant="outline"
                >
                  Remove
                </Button>
              </li>
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

export interface WorkspaceTrustSettingsSectionProps {
  /** The agent host's workspace trust; absent where no host owns folders (web). */
  readonly trust?: WorkspaceTrustCapability;
}

export function WorkspaceTrustSettingsSection({
  trust,
}: WorkspaceTrustSettingsSectionProps): React.JSX.Element {
  const [list, setList] = useState<ListState>(
    trust ? { kind: 'loading' } : { kind: 'ready', locations: [], roots: [] }
  );
  const [generation, setGeneration] = useState(0);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);

  useEffect(() => {
    if (!trust) {
      return;
    }
    let cancelled = false;
    Promise.all([trust.listTrust(), trust.listTrustedLocations()])
      .then(([roots, locations]) => {
        if (!cancelled) {
          setList({ kind: 'ready', locations, roots });
        }
      })
      .catch((error: unknown) => {
        // A failed read is its own state: never an empty list, which would
        // claim no folder is mounted or no location is trusted.
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

  /** One change at a time: records it with the host, reports a refusal in its card, then re-reads. */
  const change = async (
    path: string,
    card: ActionError['card'],
    record: (host: WorkspaceTrustCapability) => Promise<void>
  ) => {
    if (!trust) {
      return;
    }
    setBusyPath(path);
    try {
      await record(trust);
      setActionError(null);
    } catch (error: unknown) {
      setActionError({ card, message: errorMessage(error, 'The agent host refused the change') });
    }
    setBusyPath(null);
    reload();
  };

  // An answer is given for the folder it is recorded for: the repository, not one of its worktrees.
  const decide: Decide = (answer, decision, location) =>
    void change(answer.path, 'folders', (host) =>
      location === undefined
        ? host.setTrust(answer.path, decision)
        : host.setTrust(answer.path, decision, location)
    );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Trusted folders</CardTitle>
          <CardDescription>
            A folder’s <code>AGENTS.md</code>, skills, slash commands and subagents can steer the
            assistant, so Brainstrike loads them only from folders you trust. A folder you haven’t
            trusted still works: the assistant can read and edit it under your permission settings.
            A repository’s worktrees share its answer. Project hooks keep their own approval in
            Hooks.
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
                  onDecide={decide}
                />
              ))}
            </ul>
          ) : null}
          {actionError?.card === 'folders' ? (
            <p className="text-destructive text-sm" role="alert">
              {actionError.message}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <LocationsCard
        actionError={actionError?.card === 'locations' ? actionError.message : null}
        busyPath={busyPath}
        locations={list.kind === 'ready' ? list.locations : undefined}
        onRemove={(location) =>
          void change(location.path, 'locations', (host) =>
            host.removeTrustedLocation(location.path)
          )
        }
      />
    </div>
  );
}
