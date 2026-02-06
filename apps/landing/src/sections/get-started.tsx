import { ArrowRight } from 'lucide-react';
import { motion } from 'motion/react';
import { ChapterWrapper } from '../components/chapter-wrapper';
import { GitHubIcon } from '../components/github-icon';
import { TerminalBlock } from '../components/terminal-block';

interface InstallLine {
  prompt: boolean;
  text: string;
  accent?: boolean;
}

const INSTALL_LINES: readonly InstallLine[] = [
  { prompt: true, text: 'git clone https://github.com/seandearnaley/brainstrike' },
  { prompt: true, text: 'cd brainstrike && pnpm install' },
  { prompt: true, text: 'pnpm dev --filter @brainstrike/web' },
  { prompt: false, text: '' },
  { prompt: false, text: '  ➜  Local:   http://localhost:8080/', accent: true },
  { prompt: false, text: '  ➜  Ready in 1.2s' },
];

export function GetStarted(): React.JSX.Element {
  return (
    <ChapterWrapper chapter="// 05 — get started" id="get-started">
      <div className="text-center">
        <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
          Clone. Install.
          <br />
          <span className="accent-text">Ship.</span>
        </h2>
        <p
          className="mx-auto mb-10 max-w-xl text-base sm:mb-14 sm:text-lg"
          style={{ color: 'var(--text-secondary)' }}
        >
          Three commands to a local-first AI development environment. No accounts, no API keys
          required to get started.
        </p>
      </div>

      {/* Install terminal */}
      <motion.div
        className="mx-auto mb-10 max-w-2xl sm:mb-14"
        initial={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.5 }}
        viewport={{ once: true }}
        whileInView={{ opacity: 1, y: 0 }}
      >
        <TerminalBlock title="quick-start">
          <div className="space-y-1">
            {INSTALL_LINES.map((line, i) => (
              <div className="flex gap-2" key={`install-${i.toString()}`}>
                {line.prompt && <span style={{ color: 'var(--accent)' }}>$</span>}
                <span
                  style={{
                    color: line.accent
                      ? 'var(--accent)'
                      : line.prompt
                        ? 'var(--text-primary)'
                        : 'var(--text-code)',
                  }}
                >
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        </TerminalBlock>
      </motion.div>

      {/* CTA */}
      <motion.div
        className="mb-16 flex flex-col items-center justify-center gap-3 sm:mb-20 sm:flex-row sm:gap-4"
        initial={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        viewport={{ once: true }}
        whileInView={{ opacity: 1, y: 0 }}
      >
        <a
          className="group inline-flex items-center gap-2 rounded-lg px-8 py-3.5 font-medium text-sm transition-all duration-200 hover:brightness-110"
          href="https://github.com/seandearnaley/brainstrike"
          rel="noopener noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            background: 'var(--accent)',
            color: 'white',
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
          className="inline-flex items-center gap-2 rounded-lg border px-8 py-3.5 font-medium text-sm transition-colors duration-200 hover:text-white"
          href="https://github.com/seandearnaley/brainstrike"
          rel="noopener noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            borderColor: 'var(--border-hover)',
            color: 'var(--text-secondary)',
          }}
          target="_blank"
        >
          <GitHubIcon size={16} />
          View on GitHub
        </a>
      </motion.div>

      {/* License line */}
      <p
        className="mb-8 text-center text-xs"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
      >
        MIT Licensed. Free forever.
      </p>

      {/* Minimal footer */}
      <footer className="border-t pt-6" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex flex-col items-center gap-4 text-center md:flex-row md:justify-between md:text-left">
          <div className="flex items-center gap-6">
            <a
              className="text-xs transition-colors duration-200 hover:text-white"
              href="https://github.com/seandearnaley/brainstrike"
              rel="noopener noreferrer"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
              target="_blank"
            >
              GitHub
            </a>
            <a
              className="text-xs transition-colors duration-200 hover:text-white"
              href="https://github.com/seandearnaley/brainstrike#readme"
              rel="noopener noreferrer"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
              target="_blank"
            >
              Documentation
            </a>
          </div>
          <p
            className="text-xs"
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
          >
            &copy; {new Date().getFullYear()} BrainStrike
          </p>
        </div>
      </footer>
    </ChapterWrapper>
  );
}
