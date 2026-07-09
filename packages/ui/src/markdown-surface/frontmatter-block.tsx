import type { FrontmatterResult } from './frontmatter';

/** Muted key–value properties block for YAML frontmatter (GitHub/Obsidian style).
 * Invalid YAML renders the raw block with a visible note — never silently dropped. */
export function FrontmatterBlock({ result }: { readonly result: FrontmatterResult }) {
  if (result.raw === null) {
    return null;
  }
  if (result.error !== null || result.data === null) {
    return (
      <div
        className="mb-4 rounded-md border border-amber-500/40 bg-muted/50 p-3 text-xs"
        data-testid="markdown-frontmatter-error"
      >
        <p className="mb-1 font-medium text-amber-600 dark:text-amber-400">
          Invalid frontmatter{result.error ? `: ${result.error}` : ''}
        </p>
        <pre className="overflow-x-auto text-muted-foreground">{result.raw}</pre>
      </div>
    );
  }
  return (
    <dl
      className="mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-md border bg-muted/50 p-3 text-xs"
      data-testid="markdown-frontmatter"
    >
      {Object.entries(result.data).map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="font-medium text-muted-foreground">{key}</dt>
          <dd className="break-words">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
