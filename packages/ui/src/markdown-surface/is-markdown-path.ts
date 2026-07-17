const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** True when the path's extension is a plain-markdown extension. `.mdx` is
 * deliberately excluded (JSX — source-only in v1). */
export function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot <= 0 || dot === path.length - 1) {
    return false;
  }
  return MARKDOWN_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
