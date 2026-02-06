import type { LucideIcon } from 'lucide-react';
import { useScrollReveal } from '../hooks/use-scroll-reveal';

interface FeatureCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  delay?: number;
}

export function FeatureCard({
  icon: Icon,
  title,
  description,
  delay = 0,
}: FeatureCardProps): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.15 });

  return (
    <div
      className="glass glass-hover glow-border group relative rounded-2xl p-6 transition-all duration-400"
      ref={ref}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(20px)',
        transition: `opacity 0.5s ease-out ${delay}ms, transform 0.5s ease-out ${delay}ms, border-color 0.4s ease, background 0.4s ease`,
      }}
    >
      <div
        className="mb-4 inline-flex rounded-xl p-3"
        style={{
          background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(139,92,246,0.1))',
        }}
      >
        <Icon
          className="transition-colors duration-300"
          size={24}
          style={{ color: 'var(--accent-mid)' }}
        />
      </div>
      <h3
        className="mb-2 font-semibold text-lg"
        style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}
      >
        {title}
      </h3>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {description}
      </p>
    </div>
  );
}
