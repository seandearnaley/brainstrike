import { ComposerPrimitive } from '@assistant-ui/react';
import { FileIcon } from 'lucide-react';
import type { FC, ReactNode } from 'react';
import type { FileMention, TriggerAdapter } from './file-mentions';

/**
 * Presentational popover content for the composer's "@" file-mention menu. It
 * renders AS the `role="listbox"` container of
 * `ComposerPrimitive.Unstable_TriggerPopover` (the library folded the old
 * separate `Unstable_MentionRoot` + `Unstable_MentionPopover` pair into one
 * `Unstable_TriggerPopover` in @assistant-ui/react 0.12.26 — see upstream PRs
 * #3827 "unify mention and slash command under Unstable_TriggerPopover" and
 * #3834 "TriggerPopover v2 (Directive/Action)"), which ALSO owns the "@"
 * trigger detection, keyboard navigation, and popover open/close. The library
 * primitives supply the WAI-ARIA editable-combobox semantics:
 * `Unstable_TriggerPopover` renders `aria-activedescendant`, and each
 * `Unstable_TriggerPopoverItem` is a `role="option"` button. We reuse the
 * `--bs-*` token surface from the slash popover and add a secondary line with
 * the file path + root label.
 *
 * The `Unstable_TriggerPopover.Directive` behavior sub-primitive (rendered as
 * a sibling, contributes no DOM) performs the directive insertion on select —
 * this replaces the old `Unstable_MentionRoot`'s built-in insertion behavior,
 * using the library's default formatter (unchanged serialization:
 * `:file[label]{name=id}`).
 *
 * Like slash commands, mentions expose their items via search mode (no
 * categories), so only the flat `Unstable_TriggerPopoverItems` render path is
 * used.
 */
export interface ComposerMentionPopoverProps {
  /** Trigger adapter (categories/categoryItems/search) built from the passed file list. */
  readonly adapter: TriggerAdapter;
  /** Stable `id → FileMention` lookup so each item can show its path + root. */
  readonly fileById: ReadonlyMap<string, FileMention>;
}

export const ComposerMentionPopover: FC<ComposerMentionPopoverProps> = ({ adapter, fileById }) => (
  <ComposerPrimitive.Unstable_TriggerPopover
    adapter={adapter}
    aria-label="File mentions"
    char="@"
    className="bs-composer-trigger-popover"
    data-testid="assistant-mention-popover"
  >
    <ComposerPrimitive.Unstable_TriggerPopover.Directive />
    <ComposerPrimitive.Unstable_TriggerPopoverItems>
      {(items): ReactNode =>
        items.map((item, index) => {
          const file = fileById.get(item.id);
          return (
            <ComposerPrimitive.Unstable_TriggerPopoverItem
              className="bs-composer-trigger-item bs-composer-mention-item"
              index={index}
              item={item}
              key={item.id}
            >
              <FileIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="bs-composer-mention-text">
                <span className="bs-composer-trigger-item-label">{item.label}</span>
                {file && (
                  <span className="bs-composer-mention-detail">
                    <span className="bs-composer-mention-path">{file.path}</span>
                    <span className="bs-composer-mention-root">{file.rootLabel}</span>
                  </span>
                )}
              </span>
            </ComposerPrimitive.Unstable_TriggerPopoverItem>
          );
        })
      }
    </ComposerPrimitive.Unstable_TriggerPopoverItems>
  </ComposerPrimitive.Unstable_TriggerPopover>
);

ComposerMentionPopover.displayName = 'ComposerMentionPopover';
