import { ComposerPrimitive, type Unstable_SlashCommandAction } from '@assistant-ui/react';
import { SlashIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { TriggerAdapter } from './file-mentions';

/**
 * Presentational popover content for the composer's "/" slash menu. It renders
 * AS the `role="listbox"` container of `ComposerPrimitive.Unstable_TriggerPopover`
 * (the library folded the old separate `Unstable_TriggerPopoverPopover` wrapper
 * into `Unstable_TriggerPopover` itself in @assistant-ui/react 0.12.26 — see
 * upstream PRs #3827 "unify mention and slash command under
 * Unstable_TriggerPopover" and #3834 "TriggerPopover v2 (Directive/Action)"),
 * which ALSO owns the "/" trigger detection, keyboard navigation, and
 * open/close state. The library primitives supply the WAI-ARIA
 * editable-combobox semantics for us: `Unstable_TriggerPopover` renders
 * `aria-activedescendant`, and each `Unstable_TriggerPopoverItem` is a
 * `role="option"` button (with `aria-selected` + a stable id). We only restyle
 * the chrome to the `--bs-*` token surface (no raw shadcn slate colors).
 *
 * Slash commands have no categories (the adapter exposes them via search mode),
 * so only the flat `Unstable_TriggerPopoverItems` render path is used. The
 * `Unstable_TriggerPopover.Action` behavior sub-primitive (rendered as a
 * sibling, contributes no DOM) is what actually invokes each command's
 * `execute` and clears the "/command" text — `action` comes from
 * `unstable_useSlashCommandAdapter({ ..., removeOnExecute: true })` in
 * `slash-commands.ts`, matching the pre-0.12.26 `Unstable_SlashCommandRoot`
 * behavior exactly (its docs: "the /command text is removed from the
 * composer").
 */
export interface ComposerTriggerPopoverProps {
  /** Behavior bundle (`onExecute` + `removeOnExecute`) from `unstable_useSlashCommandAdapter`. */
  readonly action: Unstable_SlashCommandAction;
  /** Trigger adapter (categories/categoryItems/search) from `unstable_useSlashCommandAdapter`. */
  readonly adapter: TriggerAdapter;
  /** Stable `id → icon` lookup for the leading item icon (resolved by command id). */
  readonly iconMap: ReadonlyMap<string, ComponentType<{ className?: string }>>;
}

export const ComposerTriggerPopover = ({
  adapter,
  action,
  iconMap,
}: ComposerTriggerPopoverProps) => (
  <ComposerPrimitive.Unstable_TriggerPopover
    adapter={adapter}
    aria-label="Slash commands"
    char="/"
    className="bs-composer-trigger-popover"
    data-testid="assistant-slash-popover"
  >
    <ComposerPrimitive.Unstable_TriggerPopover.Action {...action} />
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
  </ComposerPrimitive.Unstable_TriggerPopover>
);

ComposerTriggerPopover.displayName = 'ComposerTriggerPopover';
