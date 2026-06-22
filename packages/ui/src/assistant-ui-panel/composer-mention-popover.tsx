import { ComposerPrimitive } from '@assistant-ui/react';
import { FileIcon } from 'lucide-react';
import type { FC, ReactNode } from 'react';
import type { FileMention } from './file-mentions';

/**
 * Presentational popover content for the composer's "@" file-mention menu. It
 * renders INSIDE `ComposerPrimitive.Unstable_MentionRoot`, which owns the "@"
 * trigger detection, keyboard navigation, popover open/close, and (on select)
 * the directive insertion. The library primitives supply the WAI-ARIA
 * editable-combobox semantics: `Unstable_MentionPopover` is the `role="listbox"`
 * container (with `aria-activedescendant`), and each `Unstable_MentionItem` is a
 * `role="option"` button. We reuse the `--bs-*` token surface from the slash
 * popover and add a secondary line with the file path + root label.
 *
 * Like slash commands, mentions expose their items via search mode (no
 * categories), so only the flat `Unstable_MentionItems` render path is used.
 */
export interface ComposerMentionPopoverProps {
  /** Stable `id → FileMention` lookup so each item can show its path + root. */
  readonly fileById: ReadonlyMap<string, FileMention>;
}

export const ComposerMentionPopover: FC<ComposerMentionPopoverProps> = ({ fileById }) => (
  <ComposerPrimitive.Unstable_MentionPopover
    aria-label="File mentions"
    className="bs-composer-trigger-popover"
    data-testid="assistant-mention-popover"
  >
    <ComposerPrimitive.Unstable_MentionItems>
      {(items): ReactNode =>
        items.map((item, index) => {
          const file = fileById.get(item.id);
          return (
            <ComposerPrimitive.Unstable_MentionItem
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
            </ComposerPrimitive.Unstable_MentionItem>
          );
        })
      }
    </ComposerPrimitive.Unstable_MentionItems>
  </ComposerPrimitive.Unstable_MentionPopover>
);

ComposerMentionPopover.displayName = 'ComposerMentionPopover';
