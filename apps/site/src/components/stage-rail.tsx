export interface StageDefinition {
  readonly id: string;
  readonly label: string;
}

interface StageRailProps {
  readonly activeStage: number;
  readonly stages: readonly StageDefinition[];
}

export function StageRail({ activeStage, stages }: StageRailProps) {
  return (
    <nav aria-label="Processing stages" className="stage-rail">
      <span className="stage-rail-title">SIGNAL PATH</span>
      <ol>
        {stages.map((stage, index) => (
          <li className={index === activeStage ? 'is-active' : ''} key={stage.id}>
            <a aria-current={index === activeStage ? 'step' : undefined} href={`#${stage.id}`}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <em>{stage.label}</em>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
