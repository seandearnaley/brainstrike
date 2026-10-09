/**
 * The conflict block of the Conversation Rewind confirm modal (BST-1115).
 *
 * THE ACKNOWLEDGMENT GATE, rendered. When the pre-flight scan reports ANY
 * conflict, nothing applies — not the clean files either — until the user has
 * been shown every blocked path BY NAME and ticked this box. One conflicting
 * file blocks the whole apply; there is deliberately no per-file override and
 * no "skip the conflicted ones" button. Do not add one.
 *
 * Split into its own module so the list and its gate stay together and the
 * dialog's own cognitive complexity stays inside the lint budget.
 */
import { Checkbox } from '@brainstrike/ui';
import { AlertTriangle } from 'lucide-react';
import type { ReactElement } from 'react';
import type { RewindConflictModel } from '../rewind-port';

/**
 * Distinct conflicts for display, keyed `(rootId, path)`.
 *
 * The scan replays the whole revert plan, so ONE file edited by two runs in the
 * range legitimately produces two conflict records — and showing the user the
 * same path twice reads as two broken files. Dedupe is for DISPLAY ONLY: the
 * apply still forces exactly the records the scan flagged, never a
 * de-duplicated subset (T3's `executePlan` keys `force` on `checkpointId`).
 *
 * `rootId` is part of the key for the same reason it is part of
 * `changedFileKey`: two workspace roots routinely contain the same relative
 * path, and collapsing them would hide a whole root's conflict.
 */
export function dedupeConflictsForDisplay(
  conflicts: readonly RewindConflictModel[]
): readonly RewindConflictModel[] {
  const seen = new Set<string>();
  const unique: RewindConflictModel[] = [];
  for (const conflict of conflicts) {
    const key = `${conflict.rootId}\u0000${conflict.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(conflict);
  }
  return unique;
}

/** Whether acknowledging overwrites every listed file; the port says per file. */
function allForceable(conflicts: readonly RewindConflictModel[]): boolean {
  return conflicts.every((conflict) => conflict.forceable);
}

export function RewindConflictList({
  acknowledged,
  conflicts,
  onAcknowledgedChange,
}: {
  readonly acknowledged: boolean;
  readonly conflicts: readonly RewindConflictModel[];
  readonly onAcknowledgedChange: (next: boolean) => void;
}): ReactElement | null {
  const unique = dedupeConflictsForDisplay(conflicts);
  if (unique.length === 0) {
    return null;
  }
  const acknowledgeCopy = allForceable(unique)
    ? 'I understand these files will be overwritten with their earlier contents, and that restoring is all-or-nothing — nothing is restored until this is checked.'
    : 'I understand that restoring is all-or-nothing: files that changed since the checkpoint will be overwritten with their earlier contents, and files whose workspace root is disconnected or whose before-state is no longer stored will be left as they are. Nothing is restored until this is checked.';

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2"
      data-testid="rewind-conflicts"
    >
      <p className="flex items-center gap-1.5 font-medium text-destructive text-xs">
        <AlertTriangle aria-hidden="true" className="size-3.5" />
        {unique.length} file{unique.length === 1 ? '' : 's'} cannot be restored cleanly
      </p>
      <ul className="flex flex-col gap-0.5" data-testid="rewind-conflict-paths">
        {unique.map((conflict) => (
          <li className="text-muted-foreground text-xs" key={`${conflict.rootId}|${conflict.path}`}>
            <span className="font-mono text-foreground">{conflict.path}</span>
            {conflict.rootLabel ? <span> — {conflict.rootLabel}</span> : null}
            <span> — {conflict.message}</span>
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2 text-xs" htmlFor="rewind-acknowledge-conflicts">
        <Checkbox
          checked={acknowledged}
          data-testid="rewind-acknowledge-conflicts"
          id="rewind-acknowledge-conflicts"
          onCheckedChange={(next) => onAcknowledgedChange(next === true)}
        />
        <span className="text-muted-foreground leading-tight">{acknowledgeCopy}</span>
      </label>
    </div>
  );
}
