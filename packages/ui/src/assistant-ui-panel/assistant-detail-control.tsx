import type { FC } from 'react';
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '../dropdown-menu';
import {
  ASSISTANT_DETAIL_LEVEL_META,
  ASSISTANT_DETAIL_LEVELS,
  isAssistantDetailLevel,
} from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';

/**
 * Controls-menu section for the three-level "Detail" verbosity. Each level is a
 * radio item with a one-line rationale; selecting one persists immediately and
 * keeps the menu open (onSelect preventDefault) so the change is visible.
 * Rendered first in the menu, so it carries no leading separator.
 */
export const DetailLevelControl: FC = () => {
  const { detailLevel, setDetailLevel } = useAssistantDetailLevel();

  return (
    <>
      <DropdownMenuLabel className="px-1 text-[10px] text-muted-foreground uppercase tracking-wide">
        Detail
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        onValueChange={(value) => {
          if (isAssistantDetailLevel(value)) {
            setDetailLevel(value);
          }
        }}
        value={detailLevel}
      >
        {ASSISTANT_DETAIL_LEVELS.map((level) => {
          const meta = ASSISTANT_DETAIL_LEVEL_META[level];
          return (
            <DropdownMenuRadioItem
              className="items-start"
              key={level}
              onSelect={(event) => event.preventDefault()}
              value={level}
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{meta.label}</p>
                <p className="text-muted-foreground text-xs">{meta.description}</p>
              </div>
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
};
