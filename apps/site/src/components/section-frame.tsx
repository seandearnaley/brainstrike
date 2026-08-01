import type { ReactNode } from 'react';

interface SectionFrameProps {
  readonly children: ReactNode;
  readonly code: string;
  readonly copy: string;
  readonly id: string;
  readonly kicker: string;
  readonly side: 'left' | 'right';
  readonly stage: number;
  readonly title: ReactNode;
}

export function SectionFrame({
  children,
  code,
  copy,
  id,
  kicker,
  side,
  stage,
  title,
}: SectionFrameProps) {
  return (
    <section className={`story-section story-section-${side}`} data-scroll-section id={id}>
      <span
        aria-hidden="true"
        className="scene-anchor"
        data-scene-anchor
        data-scene-stage={stage}
        id={`${id}-scene`}
      />
      <div className="section-copy">
        <div className="section-index">
          <span>{String(stage + 1).padStart(2, '0')}</span>
          <span>{code}</span>
        </div>
        <p className="eyebrow">{kicker}</p>
        <h2>{title}</h2>
        <p className="section-description">{copy}</p>
        {children}
      </div>
    </section>
  );
}
