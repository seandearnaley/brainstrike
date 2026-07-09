import { parse } from 'yaml';

export interface FrontmatterResult {
  /** Markdown with the frontmatter block removed. */
  readonly body: string;
  /** Parsed YAML mapping, or null when absent/invalid/non-mapping. */
  readonly data: Record<string, unknown> | null;
  /** Parse/shape error message; null when absent or valid. */
  readonly error: string | null;
  /** The raw YAML text between the fences; null when absent. */
  readonly raw: string | null;
}

// Frontmatter must open the document: optional BOM, `---`, newline, optional
// content, closing `---` (or YAML's `...`) on its own line. The content group is
// optional so an empty block (`---\n---\n`) matches and is stripped from the body.
const FRONTMATTER_RE = /^﻿?---\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)\r?\n?/;

export function extractFrontmatter(markdown: string): FrontmatterResult {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    return { body: markdown, data: null, error: null, raw: null };
  }
  const raw = match[1] ?? '';
  const body = markdown.slice(match[0].length);
  // Empty/whitespace-only frontmatter carries no properties: strip it from the
  // body but render nothing (raw === null => no block).
  if (raw.trim() === '') {
    return { body, data: null, error: null, raw: null };
  }
  try {
    const parsed: unknown = parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { body, data: parsed as Record<string, unknown>, error: null, raw };
    }
    return { body, data: null, error: 'Frontmatter is not a YAML mapping', raw };
  } catch (error) {
    return { body, data: null, error: error instanceof Error ? error.message : String(error), raw };
  }
}
