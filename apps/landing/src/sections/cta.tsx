import { ArrowRight } from 'lucide-react';
import { GitHubIcon } from '../components/github-icon';
import { GlowOrb } from '../components/glow-orb';
import { GradientText } from '../components/gradient-text';
import { SectionWrapper } from '../components/section-wrapper';

export function CTA(): React.JSX.Element {
  return (
    <SectionWrapper>
      <GlowOrb color="var(--accent-start)" delay={0} left="30%" size={350} top="50%" />
      <GlowOrb color="var(--accent-end)" delay={3} left="70%" size={300} top="40%" />

      <div className="relative z-10 text-center">
        <h2 className="mb-4 font-bold text-3xl sm:mb-6 sm:text-4xl md:text-5xl lg:text-6xl">
          Ready to <GradientText>Strike</GradientText>?
        </h2>
        <p
          className="mx-auto mb-8 max-w-xl text-base sm:mb-10 sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          Start exploring your codebase with AI-powered semantic search. No sign-up. No server. No
          cost.
        </p>

        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
          <a
            className="group inline-flex items-center gap-2 rounded-xl px-8 py-3.5 font-medium text-sm text-white transition-opacity duration-200 hover:opacity-90"
            href="https://github.com/seandearnaley/brainstrike"
            rel="noopener noreferrer"
            style={{
              background: 'linear-gradient(135deg, var(--accent-start), var(--accent-mid))',
            }}
            target="_blank"
          >
            Get Started
            <ArrowRight
              className="transition-transform duration-200 group-hover:translate-x-0.5"
              size={16}
            />
          </a>
          <a
            className="inline-flex items-center gap-2 rounded-xl border px-8 py-3.5 font-medium text-sm transition-colors duration-200 hover:text-white"
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
      </div>

      {/* Footer */}
      <footer
        className="relative z-10 mt-20 border-t pt-6 sm:mt-28 md:mt-32 md:pt-8"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="flex flex-col items-center gap-4 text-center md:flex-row md:justify-between md:text-left">
          <div className="flex items-center gap-6">
            <a
              className="text-xs transition-colors duration-200 hover:text-white"
              href="https://github.com/seandearnaley/brainstrike"
              rel="noopener noreferrer"
              style={{ color: 'var(--text-muted)' }}
              target="_blank"
            >
              GitHub
            </a>
            <a
              className="text-xs transition-colors duration-200 hover:text-white"
              href="https://github.com/seandearnaley/brainstrike#readme"
              rel="noopener noreferrer"
              style={{ color: 'var(--text-muted)' }}
              target="_blank"
            >
              Documentation
            </a>
          </div>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            &copy; {new Date().getFullYear()} BrainStrike. Built with React, TypeScript &amp;
            Tailwind.
          </p>
        </div>
      </footer>
    </SectionWrapper>
  );
}
