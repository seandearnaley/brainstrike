import { AnimatedCounter } from '../components/animated-counter';
import { SectionWrapper } from '../components/section-wrapper';
import { useScrollReveal } from '../hooks/use-scroll-reveal';
import { STATS, TECH_STACK } from '../lib/constants';

function TechBadge({
  name,
  category,
  index,
}: {
  name: string;
  category: string;
  index: number;
}): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.2 });

  return (
    <div
      className="glass glass-hover flex flex-col items-center justify-center rounded-xl p-4 text-center transition-all duration-300 sm:p-5"
      ref={ref}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'scale(1)' : 'scale(0.95)',
        transition: `opacity 0.4s ease-out ${index * 60}ms, transform 0.4s ease-out ${index * 60}ms, border-color 0.3s ease, background 0.3s ease`,
      }}
    >
      <span
        className="mb-1 font-semibold text-xs sm:text-sm"
        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}
      >
        {name}
      </span>
      <span
        className="text-[10px] sm:text-xs"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
      >
        {category}
      </span>
    </div>
  );
}

export function Technology(): React.JSX.Element {
  return (
    <SectionWrapper id="technology">
      <div className="mb-10 text-center sm:mb-14 md:mb-16">
        <p
          className="mb-3 font-medium text-xs uppercase tracking-widest sm:text-sm"
          style={{ color: 'var(--accent-mid)' }}
        >
          Technology
        </p>
        <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
          Built on modern foundations
        </h2>
        <p
          className="mx-auto max-w-2xl text-base sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          Production-grade architecture with battle-tested technologies. Strict TypeScript, 70%+
          test coverage, and zero compromises.
        </p>
      </div>

      {/* Tech grid */}
      <div className="mb-10 grid grid-cols-2 gap-2 sm:mb-16 sm:grid-cols-3 sm:gap-3 md:grid-cols-4 lg:grid-cols-6">
        {TECH_STACK.map((tech, index) => (
          <TechBadge category={tech.category} index={index} key={tech.name} name={tech.name} />
        ))}
      </div>

      {/* Stats */}
      <div className="glass rounded-2xl p-6 sm:p-8">
        <div className="flex flex-col items-center justify-center gap-6 text-center sm:flex-row sm:gap-12 md:gap-16">
          {STATS.map((stat) => (
            <div className="flex flex-col items-center" key={stat.label}>
              <span
                className="font-bold text-3xl sm:text-4xl md:text-5xl"
                style={{ color: 'var(--text-primary)' }}
              >
                <AnimatedCounter end={stat.value} suffix={stat.suffix} />
              </span>
              <span
                className="mt-1 text-xs sm:text-sm"
                style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
              >
                {stat.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </SectionWrapper>
  );
}
