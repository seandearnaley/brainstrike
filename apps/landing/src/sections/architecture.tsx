import { motion } from 'motion/react';
import { ChapterWrapper } from '../components/chapter-wrapper';
import { TerminalBlock } from '../components/terminal-block';

const TREE_LINES = [
  'brainstrike/',
  '├── apps/',
  '│   ├── web/            # Vite + React 19',
  '│   ├── desktop/        # Electron wrapper',
  '│   └── landing/        # This page',
  '├── packages/',
  '│   ├── ui/             # shadcn/ui + Radix',
  '│   ├── app-shell/      # IDE layout system',
  '│   ├── file-explorer/  # File analysis core',
  '│   ├── file-system/    # Platform adapters',
  '│   ├── db/             # PGlite + migrations',
  '│   ├── embeddings/     # Vector generation',
  '│   ├── queue/          # Job infrastructure',
  '│   ├── agent/          # Mastra AI integration',
  '│   ├── storage/        # Persistent adapters',
  '│   ├── types/          # Shared definitions',
  '│   └── ...             # 20+ more packages',
  '├── turbo.json',
  '└── pnpm-workspace.yaml',
] as const;

const TECH_STATS = [
  '32+ packages',
  'React 19',
  'TypeScript 5.9',
  'PGlite',
  'pgvector',
  'Vite 7',
] as const;

export function Architecture(): React.JSX.Element {
  return (
    <ChapterWrapper chapter="// 04 — architecture" id="architecture">
      <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
        Monorepo.
        <br />
        <span className="accent-text">Battle-tested.</span>
      </h2>
      <p
        className="mb-10 max-w-2xl text-base sm:mb-14 sm:text-lg"
        style={{ color: 'var(--text-secondary)' }}
      >
        Turborepo orchestrates 32+ packages with topological builds, intelligent caching, and strict
        TypeScript throughout. One codebase powers web and desktop.
      </p>

      {/* Architecture tree */}
      <TerminalBlock className="mb-10 sm:mb-14" title="project-structure">
        <div className="space-y-0.5">
          {TREE_LINES.map((line, i) => (
            <motion.div
              initial={{ opacity: 0, x: -8 }}
              key={`tree-${i.toString()}`}
              style={{
                color: line.includes('#')
                  ? 'var(--text-muted)'
                  : line.includes('├') || line.includes('│') || line.includes('└')
                    ? 'var(--text-muted)'
                    : 'var(--text-code)',
              }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              viewport={{ once: true }}
              whileInView={{ opacity: 1, x: 0 }}
            >
              {line.includes('#') ? (
                <>
                  <span style={{ color: 'var(--text-code)' }}>{line.split('#')[0]}</span>
                  <span style={{ color: 'var(--text-muted)' }}>#{line.split('#')[1]}</span>
                </>
              ) : (
                line
              )}
            </motion.div>
          ))}
        </div>
      </TerminalBlock>

      {/* Tech stats row */}
      <motion.div
        className="flex flex-wrap items-center justify-center gap-3 sm:gap-4"
        initial={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.5, delay: 0.5 }}
        viewport={{ once: true }}
        whileInView={{ opacity: 1, y: 0 }}
      >
        {TECH_STATS.map((stat, i) => (
          <span
            className="rounded-md border px-3 py-1.5 text-xs sm:text-sm"
            key={stat}
            style={{
              fontFamily: 'var(--font-mono)',
              borderColor: i === 0 ? 'var(--border-accent)' : 'var(--border-subtle)',
              color: i === 0 ? 'var(--accent)' : 'var(--text-secondary)',
            }}
          >
            {stat}
          </span>
        ))}
      </motion.div>
    </ChapterWrapper>
  );
}
