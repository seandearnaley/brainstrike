import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { ChapterWrapper } from '../components/chapter-wrapper';
import { TerminalBlock } from '../components/terminal-block';

const STEPS = [
  {
    id: 'import',
    label: '01 Import',
    terminal: 'file-import',
    lines: [
      { prompt: true, text: 'brainstrike import ./src' },
      { prompt: false, text: 'Scanning directory...' },
      { prompt: false, text: 'Found 847 files (142 supported)' },
      { prompt: false, text: 'Chunking with AST-aware splitter...' },
      { prompt: false, text: '' },
      { prompt: false, text: '✓ 1,284 chunks indexed in 3.2s', accent: true },
    ],
  },
  {
    id: 'embed',
    label: '02 Embed',
    terminal: 'embedding-worker',
    lines: [
      { prompt: true, text: 'brainstrike embed --model all-MiniLM-L6-v2' },
      { prompt: false, text: 'Loading model (23MB)...' },
      { prompt: false, text: 'Generating embeddings [████████░░] 80%' },
      { prompt: false, text: 'Throughput: 142 chunks/sec' },
      { prompt: false, text: 'Inserting into pgvector (HNSW)...' },
      { prompt: false, text: '' },
      { prompt: false, text: '✓ 1,284 vectors stored locally', accent: true },
    ],
  },
  {
    id: 'search',
    label: '03 Search',
    terminal: 'vector-search',
    lines: [
      { prompt: true, text: 'brainstrike search "file tree hooks"' },
      { prompt: false, text: '' },
      { prompt: false, text: '  0.94  file-explorer/hooks.ts:42', accent: true },
      { prompt: false, text: '        → useFileTree(): manages tree state' },
      { prompt: false, text: '  0.89  app-shell/navigation.tsx:18', accent: true },
      { prompt: false, text: '        → FilePanel: renders explorer UI' },
      { prompt: false, text: '  0.85  db/schema.ts:67', accent: true },
      { prompt: false, text: '        → file_chunks: storage table' },
      { prompt: false, text: '' },
      { prompt: false, text: '3 results in 4ms' },
    ],
  },
] as const;

interface StepLine {
  readonly prompt: boolean;
  readonly text: string;
  readonly accent?: boolean;
}

export function ProductDemo(): React.JSX.Element {
  const [activeStep, setActiveStep] = useState(0);

  return (
    <ChapterWrapper chapter="// 02 — product" id="product">
      <h2 className="mb-4 font-bold text-2xl sm:text-3xl md:text-4xl lg:text-5xl">
        Three commands.
        <br />
        <span className="accent-text">Zero servers.</span>
      </h2>
      <p
        className="mb-10 max-w-2xl text-base sm:mb-14 sm:text-lg"
        style={{ color: 'var(--text-secondary)' }}
      >
        Import your codebase, generate embeddings in-browser, and search by meaning — all running
        locally in WebAssembly.
      </p>

      {/* Step tabs */}
      <div className="mb-6 flex gap-1 sm:gap-2">
        {STEPS.map((step, index) => (
          <button
            className="rounded-md px-3 py-2 font-medium text-xs transition-colors duration-200 sm:px-4 sm:text-sm"
            key={step.id}
            onClick={() => setActiveStep(index)}
            style={{
              fontFamily: 'var(--font-mono)',
              background: activeStep === index ? 'var(--accent-bg)' : 'transparent',
              color: activeStep === index ? 'var(--accent)' : 'var(--text-muted)',
              border: `1px solid ${activeStep === index ? 'var(--border-accent)' : 'var(--border-subtle)'}`,
            }}
            type="button"
          >
            {step.label}
          </button>
        ))}
      </div>

      {/* Terminal content */}
      {(() => {
        const step = STEPS[activeStep];
        if (!step) {
          return null;
        }
        return (
          <AnimatePresence mode="wait">
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 8 }}
              key={step.id}
              transition={{ duration: 0.25 }}
            >
              <TerminalBlock title={step.terminal}>
                <div className="space-y-1">
                  {step.lines.map((line: StepLine, i: number) => (
                    <div className="flex gap-2" key={`${step.id}-${i.toString()}`}>
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
          </AnimatePresence>
        );
      })()}
    </ChapterWrapper>
  );
}
