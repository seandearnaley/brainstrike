/**
 * Repository setup script consent — revocation surface (mirrors
 * `hooks-settings-section.tsx`'s Approve/Revoke shape).
 *
 * The create sheet is where a decision is MADE (and, since it stays visible
 * with the standing choice highlighted, where it's usually CHANGED too) —
 * this panel exists for "clear it entirely, with no create pending": a
 * standing approval or denial is otherwise permanent short of a factory
 * reset. Listing reads the store directly; no disk access is needed here
 * (unlike hooks, which re-reads on-disk content live) because every decision
 * already carries the script hash it was pinned to, and the create sheet
 * re-verifies that hash fresh — against the CURRENT script — every time it
 * opens, independently of what this panel shows.
 */

import {
  useWorktreeSetupConsentStore,
  worktreeSetupConsentSelectors,
} from '@brainstrike/app-state/stores/worktree-setup-consent-store';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@brainstrike/ui';
import type { ReactElement } from 'react';

export function WorktreeSetupConsentSettingsSection(): ReactElement {
  const decisionsByRepositoryId = useWorktreeSetupConsentStore(
    worktreeSetupConsentSelectors.decisionsByRepositoryId
  );
  const revoke = useWorktreeSetupConsentStore((state) => state.revoke);
  const entries = Object.entries(decisionsByRepositoryId).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Repository setup script consent</CardTitle>
        <CardDescription>
          Repositories you approved or denied to run their{' '}
          <code>.brainstrike/worktree-setup.sh</code> when creating a worktree. Revoke a decision to
          require a fresh choice next time — the create sheet also lets you change your mind before
          creating.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-setup-consent-empty">
            No repository has a standing setup-script decision.
          </p>
        ) : (
          <ul className="space-y-3">
            {entries.map(([repositoryId, record]) => (
              <li
                className="flex items-center justify-between gap-4 rounded-md border p-3"
                data-testid={`worktree-setup-consent-${repositoryId}`}
                key={repositoryId}
              >
                <p className="min-w-0 truncate break-all font-mono text-xs">{repositoryId}</p>
                <div className="flex items-center gap-2">
                  <Badge variant={record.decision === 'approved' ? 'default' : 'secondary'}>
                    {record.decision === 'approved' ? 'Allowed' : 'Skipped'}
                  </Badge>
                  <Button
                    data-testid={`worktree-setup-consent-revoke-${repositoryId}`}
                    onClick={() => revoke(repositoryId)}
                    size="sm"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
