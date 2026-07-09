/**
 * Context information for building embedding text with file/section metadata.
 * Adding context helps embedding models understand where content comes from,
 * improving retrieval accuracy for queries like "code in utils.ts" or
 * "installation section".
 */
export interface ChunkContext {
  /** File path relative to project root (e.g., "src/utils/helpers.ts") */
  filePath?: string;
  /** Heading path for markdown files (e.g., "Getting Started > Installation") */
  headingPath?: string;
  /** Programming language detected from file extension */
  language?: string;
}

/**
 * Build embedding text with contextual metadata prepended.
 *
 * This improves retrieval accuracy by including file path and section
 * information in the embedded text, allowing queries like:
 * - "authentication code in user-service.ts"
 * - "installation instructions"
 * - "Python utilities"
 *
 * @param content - The raw content to embed
 * @param ctx - Contextual metadata to prepend
 * @returns Content with context prefix, or original content if no context provided
 *
 * @example
 * ```ts
 * const text = buildEmbeddingText(
 *   'export function validateEmail(email: string) { ... }',
 *   { filePath: 'src/validators/email.ts', language: 'typescript' }
 * );
 * // Returns:
 * // "File: src/validators/email.ts
 * // Language: typescript
 * //
 * // export function validateEmail(email: string) { ... }"
 * ```
 */
export function buildEmbeddingText(content: string, ctx: ChunkContext): string {
  const contextLines: string[] = [];

  if (ctx.filePath) {
    contextLines.push(`File: ${ctx.filePath}`);
  }

  if (ctx.headingPath) {
    contextLines.push(`Section: ${ctx.headingPath}`);
  }

  if (ctx.language) {
    contextLines.push(`Language: ${ctx.language}`);
  }

  // If no context, return original content
  if (contextLines.length === 0) {
    return content;
  }

  // Prepend context with blank line separator
  return `${contextLines.join('\n')}\n\n${content}`;
}

/**
 * Extract heading path from markdown content by tracking nested headings.
 *
 * @param content - Markdown content up to the current chunk
 * @returns Heading path like "Getting Started > Installation > Prerequisites"
 */
export function extractHeadingPath(content: string): string | undefined {
  const lines = content.split('\n');
  const headingStack: Array<{ level: number; text: string }> = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = (match[1] as string).length;
      const text = (match[2] as string).trim();

      // Pop headings of same or higher level (lower number = higher in hierarchy)
      while (headingStack.length > 0) {
        const last = headingStack.at(-1);
        if (last && last.level >= level) {
          headingStack.pop();
        } else {
          break;
        }
      }

      headingStack.push({ level, text });
    }
  }

  if (headingStack.length === 0) {
    return;
  }

  return headingStack.map((h) => h.text).join(' > ');
}

/**
 * Detect programming language from file extension.
 *
 * @param filePath - File path or name with extension
 * @returns Language name or undefined if not recognized
 */
export function detectLanguage(filePath: string): string | undefined {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filePath.length - 1) {
    return;
  }
  const ext = filePath.slice(dotIndex + 1).toLowerCase();

  const languageMap: Record<string, string> = {
    bash: 'shell',
    c: 'c',
    cjs: 'javascript',
    cpp: 'cpp',

    // .NET
    cs: 'csharp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',

    // Web
    html: 'html',

    // JVM
    java: 'java',
    // JavaScript/TypeScript
    js: 'javascript',

    // Data/Config
    json: 'json',
    jsx: 'javascript',
    kt: 'kotlin',
    m: 'objective-c',

    // Documentation
    md: 'markdown',
    mdx: 'markdown',
    mjs: 'javascript',
    mm: 'objective-c',
    php: 'php',

    // Scripting
    py: 'python',
    rb: 'ruby',

    // Systems
    rs: 'rust',
    sass: 'sass',
    scala: 'scala',
    scss: 'scss',
    sh: 'shell',

    // Database
    sql: 'sql',
    svelte: 'svelte',

    // Mobile
    swift: 'swift',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'vue',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  };

  // Chunking calls this for every file; avoid splitting the full path when
  // only the suffix after the final dot matters.
  return languageMap[ext];
}
