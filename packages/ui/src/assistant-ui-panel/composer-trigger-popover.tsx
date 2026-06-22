import { ComposerPrimitive } from '@assistant-ui/react';
import { SlashIcon } from 'lucide-react';
import type { ComponentType, FC, ReactNode } from 'react';

/**
 * Presentational popover content for the composer's "/" slash menu. It renders
 * INSIDE `ComposerPrimitive.Unstable_SlashCommandRoot`, which owns the trigger
 * detection, keyboard navigation, and popover open/close state. The library
 * primitives supply the WAI-ARIA editable-combobox semantics for us:
 * `Unstable_TriggerPopoverPopover` is the `role="listbox"` container (with
 * `aria-activedescendant`), and each `Unstable_TriggerPopoverItem` is a
 * `role="option"` button (with `aria-selected` + a stable id). We only restyle
 * the chrome to the `--bs-*` token surface (no raw shadcn slate colors).
 *
 * Slash commands have no categories (the adapter exposes them via search mode),
 * so only the flat `Unstable_TriggerPopoverItems` render path is used.
 */
export interface ComposerTriggerPopoverProps {
  /** Stable `id → icon` lookup for the leading item icon (resolved by command id). */
  readonly iconMap: ReadonlyMap<string, ComponentType<{ className?: string }>>;
}

export const ComposerTriggerPopover: FC<ComposerTriggerPopoverProps> = ({ iconMap }) => (
  <ComposerPrimitive.Unstable_TriggerPopoverPopover
    aria-label="Slash commands"
    className="bs-composer-trigger-popover"
    data-testid="assistant-slash-popover"
  >
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items): ReactNode =>
        items.map((item, index) => {
          const Icon = iconMap.get(item.id) ?? SlashIcon;
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              className="bs-composer-trigger-item"
              index={index}
              item={item}
              key={item.id}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="bs-composer-trigger-item-label">{item.label}</span>
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          );
        })
      }
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  </ComposerPrimitive.Unstable_TriggerPopoverPopover>
);

ComposerTriggerPopover.displayName = 'ComposerTriggerPopover';
