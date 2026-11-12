/**
 * Repository setup script consent — revocation surface (ADR-0034). The agent
 * host keeps each repository's answer; this section lists them and revokes
 * one, so the repository's next worktree asks again.
 *
 * The create sheet is where an answer is MADE (and, since it stays visible
 * with the standing choice highlighted, where it's usually CHANGED too) —
 * this panel exists for "clear it entirely, with no create pending". Each
 * answer is for the script's bytes it was given for: the host shows it in the
 * create sheet, and runs the script, only while the script still hashes to
 * them.
 */
import type { WorktreeSetupConsent } from '@brainstrike/types';
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
import { type ReactElement, useEffect, useState } from 'react';

/** The host's recorded answers, read and revoked through their owner. */
export interface WorktreeSetupConsents {
  list(): Promise<readonly WorktreeSetupConsent[]>;
  revoke(repositoryId: string): Promise<void>;
}

type Listing =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'failed' }
  | { readonly answers: readonly WorktreeSetupConsent[]; readonly status: 'ready' };

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function WorktreeSetupConsentSettingsSection({
  consents,
}: {
  readonly consents: WorktreeSetupConsents;
}): ReactElement {
  const [listing, setListing] = useState<Listing>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [revoking, setRevoking] = useState<string>();
  const [revokeError, setRevokeError] = useState<string>();
  // `revision` rereads: a retry or a revoke bumps it.
  useEffect(() => {
    let current = true;
    consents.list().then(
      (answers) => {
        if (current) {
          setListing({ answers, status: 'ready' });
        }
      },
      (cause: unknown) => {
        if (current) {
          setListing({ error: message(cause), status: 'failed' });
        }
      }
    );
    return () => {
      current = false;
    };
  }, [consents, revision]);
  const reload = (): void => {
    setListing({ status: 'loading' });
    setRevision((value) => value + 1);
  };
  const revoke = async (repositoryId: string): Promise<void> => {
    setRevoking(repositoryId);
    setRevokeError(undefined);
    try {
      await consents.revoke(repositoryId);
      setRevision((value) => value + 1);
    } catch (cause) {
      setRevokeError(`Couldn't revoke ${repositoryId}: ${message(cause)}`);
    }
    setRevoking(undefined);
  };
  const answers = listing.status === 'ready' ? listing.answers : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repository setup script consent</CardTitle>
        <CardDescription>
          Repositories you allowed or skipped to run their{' '}
          <code>.brainstrike/worktree-setup.sh</code> in every new worktree, including the ones the
          assistant makes. Revoke an answer to be asked again next time — the create sheet also lets
          you change your mind before creating.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {listing.status === 'loading' ? <p role="status">Loading setup script answers…</p> : null}
        {listing.status === 'failed' ? (
          <ErrorNotice
            message={`Unable to load setup script answers: ${listing.error}`}
            onRetry={reload}
          />
        ) : null}
        {listing.status === 'ready' && answers.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-setup-consent-empty">
            No repository has a standing setup-script decision.
          </p>
        ) : null}
        {answers.length > 0 ? (
          <ul aria-label="Setup script answers" className="space-y-3">
            {answers.map((entry) => (
              <li
                className="flex items-center justify-between gap-4 rounded-md border p-3"
                data-testid={`worktree-setup-consent-${entry.repositoryId}`}
                key={entry.repositoryId}
              >
                <p className="min-w-0 truncate font-mono text-xs break-all">{entry.repositoryId}</p>
                <div className="flex items-center gap-2">
                  <Badge variant={entry.decision === 'approved' ? 'default' : 'secondary'}>
                    {entry.decision === 'approved' ? 'Allowed' : 'Skipped'}
                  </Badge>
                  <Button
                    data-testid={`worktree-setup-consent-revoke-${entry.repositoryId}`}
                    disabled={revoking !== undefined}
                    onClick={() => void revoke(entry.repositoryId)}
                    size="sm"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {revokeError === undefined ? null : <p role="alert">{revokeError}</p>}
      </CardContent>
    </Card>
  );
}
