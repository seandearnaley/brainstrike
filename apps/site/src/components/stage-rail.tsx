import type { ProductStageRailEntry } from '../content/product-story';
import { type SceneFormationIndex, sceneFormationIndex } from '../scene/scene-formations';

interface StageRailProps {
  readonly activeStage: SceneFormationIndex;
  readonly stages: readonly ProductStageRailEntry[];
}

export function StageRail({ activeStage, stages }: StageRailProps) {
  return (
    <nav aria-label="Processing stages" className="stage-rail">
      <span className="stage-rail-title">SIGNAL PATH</span>
      <ol>
        {stages.map((stage, index) => (
          <li
            className={sceneFormationIndex(stage.formation) === activeStage ? 'is-active' : ''}
            key={stage.id}
          >
            <a
              aria-current={
                sceneFormationIndex(stage.formation) === activeStage ? 'step' : undefined
              }
              href={`#${stage.id}`}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <em>{stage.railLabel}</em>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
