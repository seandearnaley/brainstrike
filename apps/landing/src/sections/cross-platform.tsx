import { Globe, Monitor } from 'lucide-react';
import { SectionWrapper } from '../components/section-wrapper';
import { useScrollReveal } from '../hooks/use-scroll-reveal';

function PlatformCard({
  icon: Icon,
  title,
  features,
  delay,
}: {
  icon: React.ComponentType<{ size: number; style?: React.CSSProperties }>;
  title: string;
  features: readonly string[];
  delay: number;
}): React.JSX.Element {
  const { ref, isVisible } = useScrollReveal({ threshold: 0.2 });

  return (
    <div
      className="glass glass-hover rounded-2xl p-6 sm:p-8"
      ref={ref}
      style={{
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(20px)',
        transition: `opacity 0.6s ease-out ${delay}ms, transform 0.6s ease-out ${delay}ms, border-color 0.3s ease, background 0.3s ease`,
      }}
    >
      <Icon size={28} style={{ color: 'var(--accent-mid)' }} />
      <h3
        className="mt-3 mb-4 font-bold text-xl sm:mt-4 sm:text-2xl"
        style={{ fontFamily: 'var(--font-heading)', color: 'var(--text-primary)' }}
      >
        {title}
      </h3>
      <ul className="space-y-2.5 sm:space-y-3">
        {features.map((feature) => (
          <li
            className="flex items-start gap-3 text-sm"
            key={feature}
            style={{ color: 'var(--text-secondary)' }}
          >
            <span
              className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: 'var(--accent-end)' }}
            />
            {feature}
          </li>
        ))}
      </ul>
    </div>
  );
}

const WEB_FEATURES = [
  'File System Access API for secure folder browsing',
  'IndexedDB-backed persistent database',
  'Deploy to any static hosting provider',
  'On-demand embedding worker control',
] as const;

const DESKTOP_FEATURES = [
  'Native file system access to any folder',
  'MCP server integration for AI capabilities',
  'Auto-start embedding worker on launch',
  'Application-level persistent storage',
] as const;

export function CrossPlatform(): React.JSX.Element {
  return (
    <SectionWrapper>
      <div className="mb-10 text-center sm:mb-14 md:mb-16">
        <p
          className="mb-3 font-medium text-xs uppercase tracking-widest sm:text-sm"
          style={{ color: 'var(--accent-mid)' }}
        >
          Cross-Platform
        </p>
        <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
          One codebase. Every platform.
        </h2>
        <p
          className="mx-auto max-w-2xl text-base sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          The adapter pattern enables a single source of truth for business logic while
          platform-specific adapters handle the rest.
        </p>
      </div>

      <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
        <PlatformCard delay={0} features={WEB_FEATURES} icon={Globe} title="Web" />
        <PlatformCard delay={150} features={DESKTOP_FEATURES} icon={Monitor} title="Desktop" />
      </div>
    </SectionWrapper>
  );
}
