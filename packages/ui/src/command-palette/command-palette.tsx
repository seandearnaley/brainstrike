import type {
  Command,
  CommandContext,
  CommandGroup,
  CommandPage,
} from '@brainstrike/context-actions/commands';
import { createLogger } from '@brainstrike/logging';
import { Description as DialogDescription, Title as DialogTitle } from '@radix-ui/react-dialog';
import { Command as Cmdk } from 'cmdk';
import * as React from 'react';
import { COMMAND_PALETTE_CONTENT_CLASS, COMMAND_PALETTE_OVERLAY_CLASS } from '../layers';
import { cn } from '../lib/utils';
import { useToast } from '../use-toast';
import { filterCommands } from './use-command-search';

const logger = createLogger('CommandPalette');

/**
 * Stable presentation order for the palette's section headings. Commands whose
 * `group` is undefined fall into the trailing `workspace` bucket so they remain
 * reachable rather than silently dropped.
 */
const GROUP_ORDER: readonly CommandGroup[] = ['navigate', 'thread', 'file', 'workspace', 'danger'];

const GROUP_HEADINGS: Record<CommandGroup, string> = {
  danger: 'Danger',
  file: 'File',
  navigate: 'Navigate',
  thread: 'Thread',
  workspace: 'Workspace',
};

const DEFAULT_GROUP: CommandGroup = 'workspace';

export interface CommandPaletteProps {
  /** The capability-gated, target-bound command list the app resolved on open. */
  readonly commands: readonly Command[];
  /** The execution context handed to a command's `run` on selection. */
  readonly context: CommandContext;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

interface CommandSection {
  readonly commands: readonly Command[];
  readonly heading: string;
}

/**
 * Derives the grouped, ordered command sections from the filtered list DURING
 * RENDER (no effect/setState — react-doctor `no-adjust-state-on-prop-change`).
 * Single pass over the commands: bucket each into its group, then emit the
 * non-empty buckets in the stable GROUP_ORDER (preserving per-group order).
 */
function groupCommands(commands: readonly Command[]): readonly CommandSection[] {
  const buckets = new Map<CommandGroup, Command[]>();
  for (const command of commands) {
    const group = command.group ?? DEFAULT_GROUP;
    const existing = buckets.get(group);
    if (existing) {
      existing.push(command);
    } else {
      buckets.set(group, [command]);
    }
  }
  const sections: CommandSection[] = [];
  for (const group of GROUP_ORDER) {
    const grouped = buckets.get(group);
    if (grouped && grouped.length > 0) {
      sections.push({ commands: grouped, heading: GROUP_HEADINGS[group] });
    }
  }
  return sections;
}

/**
 * The ⌘K command palette: a presentational cmdk dialog over a resolved command
 * list. It never resolves availability or builds the registry itself — the app
 * passes the already-available commands plus the execution context (captured at
 * open time, per the bridge's snapshot semantics). Filtering is a local,
 * case-insensitive substring match; selection invokes `command.run(context)`.
 *
 * A page command (Go to Tab…) swaps the list for its page instead of running;
 * Backspace in an empty query goes back, and closing always resets to the root.
 *
 * No-silent-fallbacks: a failing `ActionOutcome` ({ ok: false }) — or a thrown
 * run — surfaces a toast and a log; success closes the palette. The palette
 * never swallows a command failure.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  context,
}: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState<CommandPage | null>(null);
  const { toast } = useToast();

  // Derive the filtered + grouped sections during render — no setState in an
  // effect. The command list is owned by the app; a page's list by its command.
  const sections = React.useMemo<readonly CommandSection[]>(() => {
    if (!page) {
      return groupCommands(filterCommands(commands, query));
    }
    const matches = filterCommands(page.commands, query);
    return matches.length > 0 ? [{ commands: matches, heading: page.heading }] : [];
  }, [commands, page, query]);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset whenever the palette closes so the next open starts at the root.
        setQuery('');
        setPage(null);
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleInputKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Backspace' && query === '' && page) {
        event.preventDefault();
        setPage(null);
      }
    },
    [page, query]
  );

  const handleSelect = React.useCallback(
    async (command: Command) => {
      if (command.page) {
        setPage(command.page(context));
        setQuery('');
        return;
      }
      let outcome: { ok: boolean; error?: string };
      try {
        outcome = await command.run(context);
      } catch (error) {
        outcome = {
          error: error instanceof Error ? error.message : 'Command failed unexpectedly',
          ok: false,
        };
      }
      if (outcome.ok) {
        handleOpenChange(false);
        return;
      }
      // Surface the failure (toast + log) — never swallow it.
      const description = outcome.error ?? `"${command.label}" could not be completed.`;
      reportCommandFailure(command, description);
      toast({
        description,
        title: 'Command failed',
        variant: 'destructive',
      });
    },
    [context, handleOpenChange, toast]
  );

  return (
    <Cmdk.Dialog
      contentClassName={cn(
        'fixed top-[20%] left-1/2 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
        COMMAND_PALETTE_CONTENT_CLASS,
        'overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl'
      )}
      label="Command palette"
      onOpenChange={handleOpenChange}
      open={open}
      overlayClassName={cn('fixed inset-0 bg-black/50', COMMAND_PALETTE_OVERLAY_CLASS)}
      shouldFilter={false}
    >
      {/* cmdk's Command.Dialog wraps @radix-ui/react-dialog's Content (same
          module instance as ours), which unconditionally requires a Title +
          Description for accessibility — these visually-hidden ones satisfy that
          and silence the runtime warning while keeping the palette labelled. */}
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search for a command and press Enter to run it.
      </DialogDescription>
      <div className="flex items-center border-b px-3" data-cmdk-input-wrapper="">
        <Cmdk.Input
          className={cn(
            'flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50'
          )}
          onKeyDown={handleInputKeyDown}
          onValueChange={setQuery}
          placeholder={page?.placeholder ?? 'Type a command…'}
          value={query}
        />
      </div>
      <Cmdk.List className="max-h-[320px] overflow-y-auto overflow-x-hidden p-1">
        <Cmdk.Empty className="py-6 text-center text-muted-foreground text-sm">
          {page ? 'No matches.' : 'No commands found.'}
        </Cmdk.Empty>
        {sections.map((section) => (
          <Cmdk.Group
            className="px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs"
            heading={section.heading}
            key={section.heading}
          >
            {section.commands.map((command) => (
              <CommandPaletteItem command={command} key={command.id} onSelect={handleSelect} />
            ))}
          </Cmdk.Group>
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}

interface CommandPaletteItemProps {
  readonly command: Command;
  readonly onSelect: (command: Command) => void;
}

function CommandPaletteItem({ command, onSelect }: CommandPaletteItemProps): React.ReactElement {
  const Icon = command.icon;
  const keywordHint = command.keywords?.[0];
  return (
    <Cmdk.Item
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm outline-none',
        'aria-selected:bg-accent aria-selected:text-accent-foreground'
      )}
      // Stable, unique value so cmdk keeps selection consistent across filters.
      onSelect={() => onSelect(command)}
      value={command.id}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0 opacity-70" /> : null}
      <span className="flex-1 truncate">{command.label}</span>
      {keywordHint ? (
        <span className="truncate text-muted-foreground text-xs">{keywordHint}</span>
      ) : null}
    </Cmdk.Item>
  );
}

function reportCommandFailure(command: Command, description: string): void {
  logger.error('Command failed', { description, id: command.id });
}
