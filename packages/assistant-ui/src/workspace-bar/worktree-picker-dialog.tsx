import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@brainstrike/ui';
import { type ReactElement, type RefObject, useId, useState } from 'react';
import { formatAbsoluteTime } from '../relative-time';
import type {
  WorkspaceBarArchivedWorktree,
  WorkspaceBarArchivedWorktrees,
  WorkspaceBarWorktreeOption,
  WorkspaceBarWorktreePicker,
} from './workspace-bar';

const TOOL_LABELS: Record<NonNullable<WorkspaceBarWorktreeOption['externalTool']>, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

const PickerRow = ({
  onGrantAccess,
  onSelect,
  option,
}: {
  readonly onGrantAccess: (() => void) | undefined;
  readonly onSelect: (option: WorkspaceBarWorktreeOption) => void;
  readonly option: WorkspaceBarWorktreeOption;
}): ReactElement => {
  const optionId = option.worktreeId ?? option.path;
  return (
    <li
      className="border-border/60 flex items-start gap-3 rounded-md border px-3 py-2"
      data-testid={`worktree-picker-row-${optionId}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium">{option.name}</span>
          {option.managed ? (
            <Badge data-testid={`worktree-picker-managed-${optionId}`} variant="secondary">
              Managed
            </Badge>
          ) : null}
          {option.externalTool ? (
            <Badge data-testid={`worktree-picker-tool-${optionId}`} variant="outline">
              {TOOL_LABELS[option.externalTool]}
            </Badge>
          ) : null}
          {option.current ? <Badge variant="outline">Current</Badge> : null}
        </div>
        <p className="text-muted-foreground text-2xs truncate font-mono">{option.path}</p>
        <p className="text-muted-foreground text-2xs">
          {option.repositoryName} · {option.branch ?? 'Detached HEAD'}
        </p>
        {option.disabledReason ? (
          <p
            className="text-warning text-2xs mt-1 leading-snug"
            data-testid={`worktree-picker-reason-${optionId}`}
          >
            {option.disabledReason}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        <Button
          data-testid={`worktree-picker-select-${optionId}`}
          disabled={!option.usable}
          onClick={() => onSelect(option)}
          size="sm"
          type="button"
        >
          Use
        </Button>
        {option.remedy === 'grant-access' && onGrantAccess ? (
          <Button
            data-testid={`worktree-picker-grant-${optionId}`}
            onClick={onGrantAccess}
            size="sm"
            type="button"
            variant="outline"
          >
            Grant access…
          </Button>
        ) : null}
      </div>
    </li>
  );
};

const ArchivedRow = ({
  archived,
  worktree,
}: {
  readonly archived: WorkspaceBarArchivedWorktrees;
  readonly worktree: WorkspaceBarArchivedWorktree;
}): ReactElement => (
  <li
    className="border-border/60 flex items-start gap-3 rounded-md border px-3 py-2"
    data-testid={`worktree-picker-archived-row-${worktree.worktreeId}`}
  >
    <div className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">{worktree.name}</span>
      <p className="text-muted-foreground text-2xs truncate font-mono">{worktree.path}</p>
      <p className="text-muted-foreground text-2xs">
        {worktree.branch ?? 'Detached HEAD'} · Archived{' '}
        {formatAbsoluteTime(Date.parse(worktree.archivedAt))}
      </p>
    </div>
    <Button
      className="shrink-0"
      data-testid={`worktree-picker-restore-${worktree.worktreeId}`}
      disabled={archived.disabledReason !== null || archived.restoringId !== null}
      onClick={() => archived.onRestore(worktree)}
      size="sm"
      type="button"
    >
      {archived.restoringId === worktree.worktreeId ? 'Restoring…' : 'Restore and use'}
    </Button>
  </li>
);

/**
 * The repository's archived worktrees (ADR-0034 decision 7), as the host lists
 * them: newest archive first. Restore and use brings one back with its
 * uncommitted changes and moves the thread into it; a refusal says why here.
 */
const ArchivedSection = ({
  archived,
  visible,
}: {
  readonly archived: WorkspaceBarArchivedWorktrees;
  readonly visible: readonly WorkspaceBarArchivedWorktree[];
}): ReactElement | null => {
  const headingId = useId();
  if (!(archived.entries.length > 0 || archived.loading || archived.error || archived.refusal)) {
    return null;
  }
  return (
    <section
      aria-labelledby={headingId}
      className="space-y-2"
      data-testid="worktree-picker-archived"
    >
      <h3 className="text-muted-foreground text-xs font-medium" id={headingId}>
        Archived
      </h3>
      {archived.error ? (
        <p className="text-destructive text-sm" data-testid="worktree-picker-archived-error">
          {archived.error}
        </p>
      ) : null}
      {archived.refusal ? (
        <p
          className="text-destructive text-sm"
          data-testid="worktree-picker-restore-error"
          role="alert"
        >
          {archived.refusal}
        </p>
      ) : null}
      {archived.loading ? (
        <p className="text-muted-foreground text-sm" data-testid="worktree-picker-archived-loading">
          Reading archived worktrees…
        </p>
      ) : null}
      {archived.disabledReason && archived.entries.length > 0 ? (
        <p
          className="text-muted-foreground text-2xs"
          data-testid="worktree-picker-restore-disabled-reason"
        >
          {archived.disabledReason}
        </p>
      ) : null}
      <ul aria-label="Archived worktrees" className="space-y-2">
        {visible.map((worktree) => (
          <ArchivedRow archived={archived} key={worktree.worktreeId} worktree={worktree} />
        ))}
      </ul>
    </section>
  );
};

/** A worktree matches when every word appears in one of its fields. */
function matchesQuery(fields: readonly (string | null)[], query: string): boolean {
  const haystack = fields.join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .every((word) => haystack.includes(word));
}

/**
 * Shows every supplied worktree, including unusable entries, so worktrees the
 * app can observe never look nonexistent merely because they cannot be used.
 * A filter keeps a long inventory scannable; it narrows the list, never hides
 * a worktree that matches.
 */
export function WorktreePickerDialog({
  picker,
  triggerRef,
}: {
  readonly picker: WorkspaceBarWorktreePicker;
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}): ReactElement {
  const [query, setQuery] = useState('');
  const trimmed = query.trim();
  const visible = trimmed
    ? picker.options.filter((option) =>
        matchesQuery([option.name, option.branch, option.repositoryName, option.path], trimmed)
      )
    : picker.options;
  const archivedEntries = picker.archived?.entries ?? [];
  const visibleArchived = trimmed
    ? archivedEntries.filter((worktree) =>
        matchesQuery([worktree.name, worktree.branch, worktree.path], trimmed)
      )
    : archivedEntries;
  const hasWorktrees = picker.options.length > 0 || archivedEntries.length > 0;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setQuery('');
        }
        picker.onOpenChange(open);
      }}
      open={picker.open}
    >
      <DialogContent
        className="sm:max-w-2xl"
        data-testid="worktree-picker-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef?.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Use an existing worktree</DialogTitle>
          <DialogDescription>
            Every worktree Brainstrike can see, including ones other tools created. A worktree that
            cannot be used here says why.
          </DialogDescription>
        </DialogHeader>
        {picker.error ? (
          <p className="text-destructive text-sm" data-testid="worktree-picker-error">
            {picker.error}
          </p>
        ) : null}
        {picker.loading ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-picker-loading">
            Reading the repository inventory…
          </p>
        ) : null}
        {picker.loading || picker.error || hasWorktrees ? null : (
          <p className="text-muted-foreground text-sm" data-testid="worktree-picker-empty">
            No worktrees yet — create one from this chip.
          </p>
        )}
        {hasWorktrees ? (
          <Input
            aria-label="Filter worktrees"
            data-testid="worktree-picker-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, branch or path"
            type="search"
            value={query}
          />
        ) : null}
        {trimmed && visible.length === 0 && visibleArchived.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            No worktrees match “{trimmed}”.
          </p>
        ) : null}
        <div className="max-h-96 space-y-3 overflow-y-auto">
          <ul aria-label="Worktrees" className="space-y-2">
            {visible.map((option) => (
              <PickerRow
                key={option.path}
                onGrantAccess={picker.onGrantAccess}
                onSelect={picker.onSelect}
                option={option}
              />
            ))}
          </ul>
          {picker.archived ? (
            <ArchivedSection archived={picker.archived} visible={visibleArchived} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
