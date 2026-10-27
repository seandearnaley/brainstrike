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
import { type ReactElement, type RefObject, useState } from 'react';
import type { WorkspaceBarWorktreeOption, WorkspaceBarWorktreePicker } from './workspace-bar';

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
      className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2"
      data-testid={`worktree-picker-row-${optionId}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-sm">{option.name}</span>
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
        <p className="truncate font-mono text-[11px] text-muted-foreground">{option.path}</p>
        <p className="text-[11px] text-muted-foreground">
          {option.repositoryName} · {option.branch ?? 'Detached HEAD'}
        </p>
        {option.disabledReason ? (
          <p
            className="mt-1 text-[11px] text-warning leading-snug"
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

/** A worktree matches when every word appears in its name, branch, repository or path. */
function matchesQuery(option: WorkspaceBarWorktreeOption, query: string): boolean {
  const haystack = [option.name, option.branch ?? '', option.repositoryName, option.path]
    .join(' ')
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
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
    ? picker.options.filter((option) => matchesQuery(option, trimmed))
    : picker.options;
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
            Every worktree BrainStrike can see, including ones other tools created. A worktree that
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
        {!(picker.loading || picker.error) && picker.options.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-picker-empty">
            No worktrees yet — create one from this chip.
          </p>
        ) : null}
        {picker.options.length > 0 ? (
          <Input
            aria-label="Filter worktrees"
            data-testid="worktree-picker-filter"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, branch or path"
            type="search"
            value={query}
          />
        ) : null}
        {trimmed && visible.length === 0 ? (
          <p className="text-muted-foreground text-sm" role="status">
            No worktrees match “{trimmed}”.
          </p>
        ) : null}
        <ul aria-label="Worktrees" className="max-h-96 space-y-2 overflow-y-auto">
          {visible.map((option) => (
            <PickerRow
              key={option.path}
              onGrantAccess={picker.onGrantAccess}
              onSelect={picker.onSelect}
              option={option}
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
