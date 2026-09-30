// Seven occurrences use measured dark surfaces; two redundant aria-hidden icons
// are decorative. Exact literals, cardinality and evidence fail when stale.
const bootstrapPath = 'apps/desktop/src/renderer/main.tsx';
const bootstrapAnchors = ['red', 'amber'].map((hue) => ({
  count: 1,
  literal: `w-full max-w-3xl rounded-xl border border-${hue}-400/30 bg-[#111827] p-6 shadow-2xl`,
}));
const terminalLiteral =
  'min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words bg-black/95 p-3 font-mono text-[12px] text-zinc-100 leading-5';

export const FOREGROUND_SURFACE_EXCEPTIONS = [
  ...[
    ['mt-3 text-slate-200 text-sm', 'text-slate-200', 2],
    ['mt-3 text-slate-300 text-sm', 'text-slate-300', 2],
    ['font-medium text-slate-200 text-sm', 'text-slate-200', 1],
    ['mt-2 list-disc space-y-1 pl-5 text-red-200 text-sm', 'text-red-200', 1],
  ].map(([literal, utility, count]) => ({
    anchors: bootstrapAnchors,
    count,
    literal,
    path: bootstrapPath,
    reason:
      'Desktop startup/outside-Electron diagnostics mount before theme providers on their own fixed #111827 panels in every mode.',
    surfaces: { 'fixed #111827 bootstrap panel': [17 / 255, 24 / 255, 39 / 255] },
    utility,
  })),
  {
    anchors: [{ count: 1, literal: terminalLiteral }],
    count: 1,
    literal: terminalLiteral,
    path: 'packages/app-shell/src/terminal-panel/command-session-inventory.tsx',
    reason:
      'Command output explicitly paints black at 95% opacity; compositing over white bounds the brightest possible sRGB backdrop in every mode.',
    surfaces: { 'bg-black/95 over white': [0.05, 0.05, 0.05] },
    utility: 'text-zinc-100',
  },
  {
    count: 1,
    decorative: true,
    element: 'Braces',
    literal: 'size-3.5 text-sky-500',
    path: 'packages/app-shell/src/prompt-workbench-builder-dialog.tsx',
    reason:
      'The aria-hidden Braces decorates variable badges that spell out every variable; it carries no state or exclusive information.',
    utility: 'text-sky-500',
  },
  {
    count: 1,
    decorative: true,
    element: 'WandSparkles',
    literal: 'size-3.5 text-sky-500',
    path: 'packages/app-shell/src/prompt-workbench-panel.tsx',
    reason:
      'The aria-hidden WandSparkles decorates the adjacent Contextual recall heading; it carries no state or exclusive information.',
    utility: 'text-sky-500',
  },
];
