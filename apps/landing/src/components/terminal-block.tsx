interface TerminalBlockProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
  showLineNumbers?: boolean;
}

export function TerminalBlock({
  title = 'terminal',
  children,
  className = '',
  showLineNumbers = false,
}: TerminalBlockProps): React.JSX.Element {
  return (
    <div className={`terminal-surface overflow-hidden ${className}`}>
      {/* Window chrome */}
      <div
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span className="h-3 w-3 rounded-full" style={{ background: 'oklch(0.65 0.2 25)' }} />
        <span className="h-3 w-3 rounded-full" style={{ background: 'oklch(0.75 0.18 85)' }} />
        <span className="h-3 w-3 rounded-full" style={{ background: 'oklch(0.7 0.18 150)' }} />
        <span
          className="ml-2 text-xs"
          style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}
        >
          {title}
        </span>
      </div>

      {/* Content */}
      <div
        className="p-4 font-mono text-sm leading-relaxed sm:p-6"
        style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-code)' }}
      >
        {showLineNumbers ? (
          <div className="flex gap-4">
            <div
              aria-hidden="true"
              className="select-none text-right"
              style={{ color: 'var(--text-muted)', minWidth: '2ch' }}
            >
              {/* Line numbers are rendered by the parent passing numbered content */}
            </div>
            <div className="flex-1">{children}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
