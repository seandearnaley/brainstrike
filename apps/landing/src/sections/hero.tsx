import { ArrowRight } from 'lucide-react';
import { GitHubIcon } from '../components/github-icon';
import { GlowOrb } from '../components/glow-orb';
import { GradientText } from '../components/gradient-text';
import { GridBackground } from '../components/grid-background';

export function Hero(): React.JSX.Element {
  return (
    <section className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-6 pt-20">
      <GridBackground />
      <GlowOrb color="var(--accent-start)" delay={0} left="20%" size={400} top="30%" />
      <GlowOrb color="var(--accent-end)" delay={2} left="75%" size={350} top="60%" />
      <GlowOrb color="var(--accent-mid)" delay={4} left="55%" size={300} top="20%" />

      <div className="relative z-10 mx-auto max-w-4xl text-center">
        {/* Badge */}
        <div
          className="glass mb-6 inline-flex items-center gap-2 rounded-full px-4 py-1.5 font-medium text-xs sm:mb-8"
          style={{ color: 'var(--text-secondary)' }}
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--accent-end)' }}
          />
          Local-first AI context management
        </div>

        {/* Headline */}
        <h1 className="mb-5 font-bold text-4xl tracking-tight sm:mb-6 sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl">
          Your Knowledge. <GradientText>Vectorized.</GradientText>
          <br />
          <GradientText>Searchable.</GradientText> Local.
        </h1>

        {/* Subheadline */}
        <p
          className="mx-auto mb-8 max-w-2xl text-base sm:mb-10 sm:text-lg md:text-xl"
          style={{ color: 'var(--text-secondary)' }}
        >
          The AI context management suite that runs entirely in your browser. No servers. No data
          leaks. Just intelligence.
        </p>

        {/* CTAs */}
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
          <a
            className="group inline-flex items-center gap-2 rounded-xl px-6 py-3 font-medium text-sm text-white transition-opacity duration-200 hover:opacity-90"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              background: 'linear-gradient(135deg, var(--accent-start), var(--accent-mid))',
            }}
            target="_blank"
          >
            Try BrainStrike
            <ArrowRight
              className="transition-transform duration-200 group-hover:translate-x-0.5"
              size={16}
            />
          </a>
          <a
            className="inline-flex items-center gap-2 rounded-xl border px-6 py-3 font-medium text-sm transition-colors duration-200 hover:text-white"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              borderColor: 'var(--border-hover)',
              color: 'var(--text-secondary)',
            }}
            target="_blank"
          >
            <GitHubIcon size={16} />
            View on GitHub
          </a>
        </div>

        {/* Scroll indicator */}
        <div
          className="mt-12 flex justify-center sm:mt-16 md:mt-20"
          style={{ color: 'var(--text-muted)' }}
        >
          <div className="flex flex-col items-center gap-2 text-xs">
            <span>Scroll to explore</span>
            <div
              className="h-8 w-px"
              style={{
                background: 'linear-gradient(to bottom, var(--text-muted), transparent)',
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
