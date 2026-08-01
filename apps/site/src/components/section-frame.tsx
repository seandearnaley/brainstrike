import { type ProductStoryChapterStage, sceneAnchorId } from '../content/product-story';
import { sceneFormationIndex } from '../scene/scene-formations';

interface SectionFrameProps {
  readonly ordinal: number;
  readonly stage: ProductStoryChapterStage;
}

export function SectionFrame({ ordinal, stage }: SectionFrameProps) {
  const { code, copy, emphasis, id, instrument: Instrument, kicker, side, title } = stage;
  return (
    <section className={`story-section story-section-${side}`} data-scroll-section id={id}>
      <span
        aria-hidden="true"
        className="scene-anchor"
        data-scene-anchor
        data-scene-stage={sceneFormationIndex(stage.formation)}
        id={sceneAnchorId(stage)}
      />
      <div className="section-copy">
        <div className="section-index">
          <span>{String(ordinal).padStart(2, '0')}</span>
          <span>{code}</span>
        </div>
        <p className="eyebrow">{kicker}</p>
        <h2>
          {title}
          <br />
          <em>{emphasis}</em>
        </h2>
        <p className="section-description">{copy}</p>
        <Instrument />
      </div>
    </section>
  );
}
