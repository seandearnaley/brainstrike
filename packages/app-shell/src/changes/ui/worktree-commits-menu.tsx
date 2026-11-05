/**
 * A worktree's latest commits in the Changes source picker (ADR-0036). Each
 * opens as its own diff, the `commit` git scope. The list is read each time
 * the menu opens, so it is never stale. Without the Changes bridge there is
 * no menu.
 */
import {
  describeBoundaryError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import { createLogger } from '@brainstrike/logging';
import type { ChangesCommit, Changeset } from '@brainstrike/types';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@brainstrike/ui';
import { Check } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { useChangesBridge } from '../../workspace-git-services';
import type { ChangesBridge } from '../changes-bridge';

const logger = createLogger('WorktreeCommitsMenu');

interface WorktreeCommitsMenuProps {
  readonly isActive: (candidate: Changeset) => boolean;
  readonly onSelectChangeset: (next: Changeset) => void;
  readonly repositoryRoot: string;
  /** The workspace root that contains the worktree. */
  readonly rootId: string;
  readonly worktreePath: string;
}

type Listing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly commits: readonly ChangesCommit[]; readonly kind: 'listed' };

export function WorktreeCommitsMenu(props: WorktreeCommitsMenuProps): ReactElement | null {
  const bridge = useChangesBridge();
  if (!bridge) {
    return null;
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Commits</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 w-80 overflow-y-auto">
        <CommitItems bridge={bridge} {...props} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function CommitItems({
  bridge,
  isActive,
  onSelectChangeset,
  repositoryRoot,
  rootId,
  worktreePath,
}: WorktreeCommitsMenuProps & { readonly bridge: ChangesBridge }): ReactElement {
  const [listing, setListing] = useState<Listing>({ kind: 'loading' });
  useEffect(() => {
    let current = true;
    const settle = (next: Listing) => {
      if (current) {
        setListing(next);
      }
    };
    bridge.commits(rootId, worktreePath).then(
      (result) =>
        settle(
          result.ok
            ? { commits: result.value, kind: 'listed' }
            : { kind: 'failed', message: describeBoundaryFailure(result.error) }
        ),
      (error: unknown) => {
        logger.error('Failed to list worktree commits', { error, worktreePath });
        settle({ kind: 'failed', message: describeBoundaryError(error) });
      }
    );
    return () => {
      current = false;
    };
  }, [bridge, rootId, worktreePath]);

  if (listing.kind !== 'listed') {
    return (
      <DropdownMenuItem disabled>
        {listing.kind === 'loading' ? 'Loading…' : listing.message}
      </DropdownMenuItem>
    );
  }
  if (listing.commits.length === 0) {
    return <DropdownMenuItem disabled>No commits</DropdownMenuItem>;
  }
  return (
    <>
      {listing.commits.map(({ commitId, subject }) => {
        const candidate: Changeset = {
          kind: 'git-scope',
          repositoryRoot,
          scope: { commitId, kind: 'commit' },
          worktreePath,
        };
        return (
          <DropdownMenuItem key={commitId} onSelect={() => onSelectChangeset(candidate)}>
            {isActive(candidate) ? <Check aria-hidden="true" /> : <span className="size-4" />}
            <span className="min-w-0 flex-1 truncate">{subject}</span>
            <span className="text-muted-foreground font-mono text-xs">{commitId.slice(0, 7)}</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
