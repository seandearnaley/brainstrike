import type { ProductStageRailEntry } from '../content/product-story';

interface StageRailProps {
  readonly activeStageId: string | null;
  readonly stages: readonly ProductStageRailEntry[];
}

export function StageRail({ activeStageId, stages }: StageRailProps) {
  return (
    <nav aria-label="Processing stages" className="stage-rail">
      <span className="stage-rail-title">SIGNAL PATH</span>
      <ol>
        {stages.map((stage, index) => (
          <li className={stage.id === activeStageId ? 'is-active' : ''} key={stage.id}>
            <a aria-current={stage.id === activeStageId ? 'step' : undefined} href={`#${stage.id}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <em>{stage.railLabel}</em>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
