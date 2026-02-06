import { SectionWrapper } from '../components/section-wrapper';
import { useScrollReveal } from '../hooks/use-scroll-reveal';
import { STEPS } from '../lib/constants';

function StepCard({
  number,
  title,
  description,
  index,
}: {
  number: string;
  title: string;
  description: string;
  index: number;
}): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.2 });

  return (
    <div
      className="relative flex flex-col items-center text-center"
      ref={ref}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(24px)',
        transition: `opacity 0.5s ease-out ${index * 200}ms, transform 0.5s ease-out ${index * 200}ms`,
      }}
    >
      {/* Step number */}
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl font-bold text-lg sm:mb-6 sm:h-16 sm:w-16 sm:text-xl"
        style={{
          fontFamily: 'var(--font-mono)',
          background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(6,182,212,0.15))',
          color: 'var(--accent-mid)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {number}
      </div>

      {/* Content */}
      <h3
        className="mb-2 font-semibold text-lg sm:mb-3 sm:text-xl"
        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}
      >
        {title}
      </h3>
      <p
        className="mx-auto max-w-xs text-sm leading-relaxed"
        style={{ color: 'var(--text-secondary)' }}
      >
        {description}
      </p>
    </div>
  );
}

export function HowItWorks(): React.JSX.Element {
  return (
    <SectionWrapper id="how-it-works">
      <div className="mb-10 text-center sm:mb-14 md:mb-16">
        <p
          className="mb-3 font-medium text-xs uppercase tracking-widest sm:text-sm"
          style={{ color: 'var(--accent-mid)' }}
        >
          How It Works
        </p>
        <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
          Three steps to semantic search
        </h2>
        <p
          className="mx-auto max-w-2xl text-base sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          Go from raw files to intelligent, searchable knowledge in minutes.
        </p>
      </div>

      <div className="relative">
        {/* Connecting line (desktop) */}
        <div
          className="absolute top-7 right-0 left-0 hidden h-px sm:top-8 lg:block"
          style={{
            background:
              'linear-gradient(to right, transparent, var(--accent-start), var(--accent-mid), var(--accent-end), transparent)',
            opacity: 0.3,
          }}
        />

        <div className="grid gap-10 sm:gap-12 lg:grid-cols-3 lg:gap-8">
          {STEPS.map((step, index) => (
            <StepCard
              description={step.description}
              index={index}
              key={step.number}
              number={step.number}
              title={step.title}
            />
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
