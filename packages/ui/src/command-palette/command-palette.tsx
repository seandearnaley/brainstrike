import type { Command, CommandContext, CommandGroup } from '@brainstrike/commands';
import { createLogger } from '@brainstrike/utils/logger';
import { Command as Cmdk } from 'cmdk';
import * as React from 'react';
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
  navigate: 'Navigate',
  thread: 'Thread',
  file: 'File',
  workspace: 'Workspace',
  danger: 'Danger',
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

interface GroupedCommands {
  readonly commands: readonly Command[];
  readonly group: CommandGroup;
}

/**
 * Derives the grouped, ordered command sections from the filtered list DURING
 * RENDER (no effect/setState — react-doctor `no-adjust-state-on-prop-change`).
 * Single pass over the commands: bucket each into its group, then emit the
 * non-empty buckets in the stable GROUP_ORDER (preserving per-group order).
 */
function groupCommands(commands: readonly Command[]): readonly GroupedCommands[] {
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
  const sections: GroupedCommands[] = [];
  for (const group of GROUP_ORDER) {
    const grouped = buckets.get(group);
    if (grouped && grouped.length > 0) {
      sections.push({ group, commands: grouped });
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
  const { toast } = useToast();

  // Derive the filtered + grouped sections during render — no setState in an
  // effect. `query` is the only local state; the command list is owned by the app.
  const sections = React.useMemo(
    () => groupCommands(filterCommands(commands, query)),
    [commands, query]
  );

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) {
        // Reset the query whenever the palette closes so the next open starts clean.
        setQuery('');
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleSelect = React.useCallback(
    async (command: Command) => {
      let outcome: { ok: boolean; error?: string };
      try {
        outcome = await command.run(context);
      } catch (error) {
        outcome = {
          ok: false,
          error: error instanceof Error ? error.message : 'Command failed unexpectedly',
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
        variant: 'destructive',
        title: 'Command failed',
        description,
      });
    },
    [context, handleOpenChange, toast]
  );

  return (
    <Cmdk.Dialog
      contentClassName={cn(
        'fixed top-[20%] left-1/2 z-[60] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
        'overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl'
      )}
      label="Command palette"
      onOpenChange={handleOpenChange}
      open={open}
      overlayClassName="fixed inset-0 z-[59] bg-black/50"
      shouldFilter={false}
    >
      <span className="sr-only" id="command-palette-description">
        Search for a command and press Enter to run it.
      </span>
      <div className="flex items-center border-b px-3" data-cmdk-input-wrapper="">
        <Cmdk.Input
          aria-describedby="command-palette-description"
          className={cn(
            'flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none',
            'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50'
          )}
          onValueChange={setQuery}
          placeholder="Type a command…"
          value={query}
        />
      </div>
      <Cmdk.List className="max-h-[320px] overflow-y-auto overflow-x-hidden p-1">
        <Cmdk.Empty className="py-6 text-center text-muted-foreground text-sm">
          No commands found.
        </Cmdk.Empty>
        {sections.map((section) => (
          <Cmdk.Group
            className="px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:text-xs"
            heading={GROUP_HEADINGS[section.group]}
            key={section.group}
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
  logger.error('Command failed', { id: command.id, description });
}
