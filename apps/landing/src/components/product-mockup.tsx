import { motion } from 'motion/react';

/* ─── Data matching real app ─────────────────────────── */

const FILE_TREE = [
  { name: 'src/', type: 'folder' as const, expanded: true, depth: 0, selected: false },
  { name: 'components/', type: 'folder' as const, expanded: true, depth: 1, selected: false },
  { name: 'app-shell.tsx', type: 'file' as const, expanded: false, depth: 2, selected: true },
  { name: 'navbar.tsx', type: 'file' as const, expanded: false, depth: 2, selected: false },
  { name: 'hooks/', type: 'folder' as const, expanded: false, depth: 1, selected: false },
  { name: 'lib/', type: 'folder' as const, expanded: false, depth: 1, selected: false },
  { name: 'pages/', type: 'folder' as const, expanded: false, depth: 1, selected: false },
] as const;

const CONTEXT_FILES = [
  { name: 'app-shell.tsx', tokens: 847, checked: true },
  { name: 'navbar.tsx', tokens: 312, checked: true },
  { name: 'use-theme.ts', tokens: 156, checked: false },
] as const;

const DB_ENTRIES = [
  { name: 'app-shell.tsx', status: 'Complete', size: '1.7 KB', chunks: 3 },
  { name: 'navbar.tsx', status: 'Complete', size: '896 B', chunks: 2 },
  { name: 'use-theme.ts', status: 'Complete', size: '420 B', chunks: 1 },
] as const;

/* ─── Subcomponents ──────────────────────────────────── */

function IconSidebar(): React.JSX.Element {
  return (
    <div
      className="hidden shrink-0 flex-col items-center gap-3 border-r py-3 sm:flex"
      style={{ borderColor: 'var(--border-subtle)', width: '42px' }}
    >
      {/* File explorer icon - active */}
      <div
        className="flex h-8 w-8 items-center justify-center rounded-md"
        style={{ background: 'var(--accent-bg)' }}
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: 'var(--accent)' }}
          viewBox="0 0 24 24"
        >
          <path
            d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6Z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {/* Chat icon */}
      <div className="flex h-8 w-8 items-center justify-center rounded-md">
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: 'var(--text-muted)' }}
          viewBox="0 0 24 24"
        >
          <path
            d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {/* Settings icon */}
      <div className="flex h-8 w-8 items-center justify-center rounded-md">
        <svg
          aria-hidden="true"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          style={{ color: 'var(--text-muted)' }}
          viewBox="0 0 24 24"
        >
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

const panelTransition = { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as const };

/* ─── Main Component ─────────────────────────────────── */

export function ProductMockup(): React.JSX.Element {
  return (
    <div
      className="overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 border-b px-4 py-2"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-deep)' }}
      >
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.65 0.18 25)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.72 0.16 85)' }} />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'oklch(0.68 0.14 155)' }} />
        <span
          className="ml-3 text-[11px]"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
        >
          BrainStrike.ai
        </span>
      </div>

      {/* App body */}
      <div className="flex" style={{ minHeight: '340px' }}>
        {/* Icon sidebar */}
        <IconSidebar />

        {/* Explorer panel */}
        <motion.div
          className="shrink-0 border-r"
          initial={{ opacity: 0, x: -16 }}
          style={{ borderColor: 'var(--border-subtle)', width: '170px' }}
          transition={{ ...panelTransition, delay: 0.2 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, x: 0 }}
        >
          <div
            className="flex items-center justify-between border-b px-3 py-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="font-medium text-[11px]" style={{ color: 'var(--text-primary)' }}>
              Explorer
            </span>
          </div>
          <div className="px-2 py-2">
            <button
              className="mb-3 w-full rounded-md border px-2 py-1.5 text-left text-[10px]"
              style={{
                fontFamily: 'var(--font-mono)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
                background: 'var(--bg-elevated)',
              }}
              type="button"
            >
              Select Root
            </button>
            <div className="space-y-0.5">
              {FILE_TREE.map((item) => (
                <div
                  className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px]"
                  key={item.name}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    paddingLeft: `${item.depth * 10 + 6}px`,
                    color: item.selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                    background: item.selected ? 'var(--accent-bg)' : 'transparent',
                  }}
                >
                  <span style={{ color: 'var(--text-muted)', fontSize: '8px' }}>
                    {item.type === 'folder' ? (item.expanded ? '▾' : '▸') : ' '}
                  </span>
                  {item.name}
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Center: Context Explorer */}
        <motion.div
          className="flex min-w-0 flex-1 flex-col border-r"
          initial={{ opacity: 0, y: 16 }}
          style={{ borderColor: 'var(--border-subtle)' }}
          transition={{ ...panelTransition, delay: 0.35 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, y: 0 }}
        >
          <div className="border-b px-4 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
              Context Explorer
            </p>
            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Navigate and select files to include in your project
            </p>
          </div>
          {/* File selection list */}
          <div className="flex-1 px-4 py-3">
            <div className="space-y-2">
              {CONTEXT_FILES.map((file) => (
                <div
                  className="flex items-center justify-between text-[11px]"
                  key={file.name}
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border text-[8px]"
                      style={{
                        borderColor: file.checked ? 'var(--accent)' : 'var(--border-hover)',
                        background: file.checked ? 'var(--accent)' : 'transparent',
                        color: file.checked ? 'white' : 'transparent',
                      }}
                    >
                      ✓
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{file.name}</span>
                  </div>
                  <span style={{ color: 'var(--text-muted)' }}>{file.tokens} tokens</span>
                </div>
              ))}
            </div>
          </div>
          {/* Token count bar */}
          <div
            className="flex items-center gap-3 border-t px-4 py-2 text-[10px]"
            style={{
              borderColor: 'var(--border-subtle)',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-muted)',
            }}
          >
            <span>3 files</span>
            <span>2 selected</span>
            <span
              className="rounded-sm px-1.5 py-0.5 font-medium text-[9px]"
              style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}
            >
              WASM
            </span>
            <span className="ml-auto" style={{ color: 'var(--accent)' }}>
              1,159 tokens
            </span>
          </div>
        </motion.div>

        {/* Right: Tools panel */}
        <motion.div
          className="hidden flex-col lg:flex"
          initial={{ opacity: 0, x: 16 }}
          style={{ width: '240px' }}
          transition={{ ...panelTransition, delay: 0.5 }}
          viewport={{ once: true }}
          whileInView={{ opacity: 1, x: 0 }}
        >
          <div
            className="flex items-center justify-between border-b px-3 py-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="font-medium text-[11px]" style={{ color: 'var(--text-primary)' }}>
              Tools
            </span>
          </div>
          {/* Tabs: Assistant | Embed | DB */}
          <div
            className="flex border-b text-[10px]"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>
              Assistant
            </span>
            <span className="px-3 py-2" style={{ color: 'var(--text-muted)' }}>
              Embed
            </span>
            <span
              className="border-b-2 px-3 py-2"
              style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
            >
              DB
            </span>
          </div>
          {/* DB content */}
          <div className="flex-1 px-3 py-3">
            {/* Collection card */}
            <div
              className="mb-3 rounded-md border p-2"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}
            >
              <div className="flex items-center gap-2 text-[10px]">
                <span
                  className="font-medium"
                  style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}
                >
                  project-src
                </span>
                <span
                  className="rounded px-1.5 py-0.5 text-[8px]"
                  style={{ background: 'var(--accent-bg)', color: 'var(--accent)' }}
                >
                  Local
                </span>
              </div>
              <div
                className="mt-1 flex gap-3 text-[9px]"
                style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
              >
                <span>3 files</span>
                <span>6 chunks</span>
                <span style={{ color: 'var(--success)' }}>3/3 embedded</span>
              </div>
            </div>
            {/* File entries */}
            <div className="space-y-1.5">
              {DB_ENTRIES.map((entry) => (
                <div
                  className="flex items-center justify-between text-[10px]"
                  key={entry.name}
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>{entry.name}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded px-1.5 py-0.5 text-[8px]"
                      style={{ background: 'var(--success)', color: 'var(--bg-deep)' }}
                    >
                      {entry.status}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{entry.chunks}ch</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      {/* Status bar */}
      <div
        className="flex items-center justify-between border-t px-3 py-1.5 text-[9px]"
        style={{
          borderColor: 'var(--border-subtle)',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-muted)',
          background: 'var(--bg-deep)',
        }}
      >
        <span>Storage: PGlite WASM</span>
        <span>Queue: 0 queued, 0 running</span>
      </div>
    </div>
  );
}
