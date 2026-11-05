import { useId } from 'react';
import { ASSISTANT_DETAIL_LEVEL_META, ASSISTANT_DETAIL_LEVELS } from './assistant-detail-level';
import { useAssistantDetailLevel } from './assistant-detail-level-store.ts';

/** Native radio group keeps normal Tab and arrow-key behavior inside Controls. */
export const DetailLevelControl = () => {
  const { detailLevel, setDetailLevel } = useAssistantDetailLevel();
  const groupName = useId();

  return (
    <fieldset className="space-y-1">
      <legend className="text-muted-foreground text-2xs mb-2 px-1 font-medium tracking-wide uppercase">
        Detail
      </legend>
      {ASSISTANT_DETAIL_LEVELS.map((level) => {
        const meta = ASSISTANT_DETAIL_LEVEL_META[level];
        return (
          <label
            className="hover:bg-accent has-[:focus-visible]:ring-ring flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 has-[:focus-visible]:ring-2"
            key={level}
          >
            <input
              checked={detailLevel === level}
              className="accent-primary size-4 shrink-0"
              name={groupName}
              onChange={() => setDetailLevel(level)}
              type="radio"
              value={level}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{meta.label}</span>
              <span className="text-muted-foreground block text-xs">{meta.description}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
};
