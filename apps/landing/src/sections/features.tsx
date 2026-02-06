import { FeatureCard } from '../components/feature-card';
import { SectionWrapper } from '../components/section-wrapper';
import { FEATURES } from '../lib/constants';

export function Features(): React.JSX.Element {
  return (
    <SectionWrapper id="features">
      <div className="mb-10 text-center sm:mb-14 md:mb-16">
        <p
          className="mb-3 font-medium text-xs uppercase tracking-widest sm:text-sm"
          style={{ color: 'var(--accent-mid)' }}
        >
          Features
        </p>
        <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
          Everything runs in your browser
        </h2>
        <p
          className="mx-auto max-w-2xl text-base sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          From vector embeddings to PostgreSQL queries, BrainStrike brings server-grade capabilities
          to the client. No infrastructure required.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <FeatureCard
            delay={index * 100}
            description={feature.description}
            icon={feature.icon}
            key={feature.title}
            title={feature.title}
          />
        ))}
      </div>
    </SectionWrapper>
  );
}
