// Local barrel only — intentionally NOT exported from the package's main
// barrel: consumers import these files relatively so react-shiki stays out of
// the always-mounted chunk (MarkdownSurface keeps its independent lazy chunk).
export * from './code-block';
export * from './code-block-body';
export * from './code-block-header';
