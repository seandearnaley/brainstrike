import { motion } from 'motion/react';
import { ChapterWrapper } from '../components/chapter-wrapper';
import { TerminalBlock } from '../components/terminal-block';

const CLOUD_LINES = [
  'your-code.ts',
  '    ↓ upload',
  'vendor-server (US-East)',
  '    ↓ process',
  'vendor-database (??)',
  '    ↓ store',
  '??? who has access ???',
  '',
  '⚠ data leaves your machine',
] as const;

const LOCAL_LINES = [
  'your-code.ts',
  '    ↓ chunk',
  'WebAssembly (your browser)',
  '    ↓ embed',
  'PGlite + pgvector (your tab)',
  '    ↓ search',
  'results (your screen)',
  '',
  '✓ data never leaves your machine',
] as const;

const STATS = [
  { value: '0', label: 'servers' },
  { value: '0', label: 'bytes uploaded' },
  { value: '100%', label: 'your data' },
] as const;

export function WhyLocalFirst(): React.JSX.Element {
  return (
    <ChapterWrapper chapter="// 03 — local-first" id="local-first">
      <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
        Your code stays
        <br />
        <span className="accent-text">on your machine.</span>
      </h2>
      <p
        className="mb-10 max-w-2xl text-base sm:mb-14 sm:text-lg"
        style={{ color: 'var(--text-secondary)' }}
      >
        No cloud vendor between you and your data. BrainStrike runs PostgreSQL, vector search, and
        ML inference entirely in your browser tab.
      </p>

      {/* Comparison */}
      <div className="mb-10 grid gap-4 sm:mb-14 md:grid-cols-2 md:gap-6">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, x: 0 }}
        >
          <TerminalBlock title="the-cloud-way">
            <div className="space-y-1">
              {CLOUD_LINES.map((line, i) => (
                <div
                  key={`cloud-${i.toString()}`}
                  style={{
                    color: line.startsWith('⚠')
                      ? 'var(--danger)'
                      : line.startsWith('???')
                        ? 'var(--warning)'
                        : 'var(--text-muted)',
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          </TerminalBlock>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 20 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, x: 0 }}
        >
          <TerminalBlock title="the-brainstrike-way">
            <div className="space-y-1">
              {LOCAL_LINES.map((line, i) => (
                <div
                  key={`local-${i.toString()}`}
                  style={{
                    color: line.startsWith('✓') ? 'var(--success)' : 'var(--text-code)',
                  }}
                >
                  {line}
                </div>
              ))}
            </div>
          </TerminalBlock>
        </motion.div>
      </div>

      {/* Stats row */}
      <motion.div
        className="flex flex-col items-center justify-center gap-8 sm:flex-row sm:gap-16"
        initial={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.5, delay: 0.3 }}
        viewport={{ once: true }}
        whileInView={{ opacity: 1, y: 0 }}
      >
        {STATS.map((stat) => (
          <div className="text-center" key={stat.label}>
            <p
              className="font-bold text-3xl sm:text-4xl md:text-5xl"
              style={{ fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}
            >
              {stat.value}
            </p>
            <p
              className="mt-1 text-xs sm:text-sm"
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
            >
              {stat.label}
            </p>
          </div>
        ))}
      </motion.div>
    </ChapterWrapper>
  );
}
