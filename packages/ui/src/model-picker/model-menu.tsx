/**
 * The one search-first model list: a Radix Popover holding a cmdk command
 * list, each row a model's maker mark and name. The composer's model picker
 * and Settings' model fields render their options through it; the caller owns
 * filtering and what picking a row does.
 */
import { Command } from 'cmdk';
import { Check } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { ModelPickerSearch } from './model-picker-search';
import { ModelMark } from './utils/vendor-marks';

/** Shared by the search-first pickers (models, branches). */
export const PICKER_GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide';

export const PICKER_ROW_CLASS =
  'flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden aria-selected:bg-accent aria-selected:text-accent-foreground data-[disabled=true]:opacity-50';

export interface ModelMenuOption {
  /** A row's accessible name, where it should say more than its label and mark. */
  readonly ariaLabel?: string | undefined;
  readonly disabled?: boolean | undefined;
  /** Unique within the menu; also cmdk's value. */
  readonly key: string;
  readonly label: string;
  /** The mark's accessible name, such as "Anthropic via OpenRouter". */
  readonly markLabel?: string | undefined;
  readonly onSelect: () => void;
  /** The route that serves the model; absent for a row that is not one model (Auto). */
  readonly provider?: string | undefined;
  readonly selected?: boolean | undefined;
  /** What follows the name: capability icons, an enable glyph. */
  readonly trailing?: ReactNode;
  readonly vendor?: string | undefined;
}

export interface ModelMenuGroup {
  /** Names the group; absent for a menu of one group. */
  readonly heading?: ReactNode;
  readonly key: string;
  readonly options: readonly ModelMenuOption[];
}

export interface ModelMenuProps {
  /** Names the menu's dialog ("Choose a model"). */
  readonly 'aria-label': string;
  readonly className?: string | undefined;
  /** Shown instead of the list when there is nothing to search. */
  readonly empty?: ReactNode;
  readonly groups: readonly ModelMenuGroup[];
  readonly onOpenChange: (open: boolean) => void;
  readonly onQueryChange: (query: string) => void;
  readonly open: boolean;
  readonly query: string;
  /** The control that opens the menu; Radix makes it the popover's trigger. */
  readonly trigger: ReactElement;
}

function OptionRow({ option }: { readonly option: ModelMenuOption }) {
  return (
    <Command.Item
      {...(option.ariaLabel ? { 'aria-label': option.ariaLabel } : {})}
      className={PICKER_ROW_CLASS}
      disabled={option.disabled === true}
      onSelect={option.onSelect}
      value={option.key}
    >
      {option.provider ? (
        <ModelMark
          className="text-foreground/80"
          label={option.markLabel}
          provider={option.provider}
          vendor={option.vendor}
        />
      ) : (
        <span aria-hidden="true" className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate leading-5">{option.label}</span>
      {option.trailing}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {option.selected ? <Check aria-label="Selected" className="size-4" role="img" /> : null}
      </span>
    </Command.Item>
  );
}

export function ModelMenu({
  'aria-label': label,
  className,
  empty,
  groups,
  onOpenChange,
  onQueryChange,
  open,
  query,
  trigger,
}: ModelMenuProps) {
  const searching = query.trim().length > 0;
  const hasOptions = groups.some((group) => group.options.length > 0);
  return (
    <Popover onOpenChange={onOpenChange} open={open}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        // Radix measures the room on the side it opens; the list scrolls inside it.
        className={cn(
          'flex max-h-(--radix-popover-content-available-height) w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl p-0',
          className
        )}
        collisionPadding={8}
        sideOffset={6}
      >
        <Command className="flex min-h-0 flex-col" label="Models" shouldFilter={false}>
          <ModelPickerSearch
            onValueChange={onQueryChange}
            placeholder="Search models…"
            value={query}
          />
          <Command.List className="max-h-[min(60vh,420px)] min-h-0 overflow-y-auto p-1">
            {searching || hasOptions || empty === undefined ? (
              <Command.Empty className="text-muted-foreground px-2 py-6 text-center text-sm">
                No models match “{query.trim()}”.
              </Command.Empty>
            ) : (
              empty
            )}
            {groups.map((group) =>
              group.options.length === 0 ? null : (
                <Command.Group
                  className={PICKER_GROUP_HEADING_CLASS}
                  heading={group.heading}
                  key={group.key}
                >
                  {group.options.map((option) => (
                    <OptionRow key={option.key} option={option} />
                  ))}
                </Command.Group>
              )
            )}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
