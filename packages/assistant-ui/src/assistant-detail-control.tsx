import { useId } from 'react';
import { ASSISTANT_DETAIL_LEVEL_META, ASSISTANT_DETAIL_LEVELS } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-context';

/** Native radio group keeps normal Tab and arrow-key behavior inside Controls. */
export const DetailLevelControl = () => {
  const { detailLevel, setDetailLevel } = useAssistantDetailLevel();
  const groupName = useId();

  return (
    <fieldset className="space-y-1">
      <legend className="mb-2 px-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        Detail
      </legend>
      {ASSISTANT_DETAIL_LEVELS.map((level) => {
        const meta = ASSISTANT_DETAIL_LEVEL_META[level];
        return (
          <label
            className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
            key={level}
          >
            <input
              checked={detailLevel === level}
              className="size-4 shrink-0 accent-primary"
              name={groupName}
              onChange={() => setDetailLevel(level)}
              type="radio"
              value={level}
            />
            <span className="min-w-0">
              <span className="block font-medium text-sm">{meta.label}</span>
              <span className="block text-muted-foreground text-xs">{meta.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
};
