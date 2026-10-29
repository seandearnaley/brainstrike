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
        className="bg-muted/50 mb-4 rounded-md border border-amber-500/40 p-3 text-xs"
        data-testid="markdown-frontmatter-error"
      >
        <p className="text-warning mb-1 font-medium">
          Invalid frontmatter{result.error ? `: ${result.error}` : ''}
        </p>
        <pre className="text-muted-foreground overflow-x-auto">{result.raw}</pre>
      </div>
    );
  }
  return (
    <dl
      className="bg-muted/50 mb-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-md border p-3 text-xs"
      data-testid="markdown-frontmatter"
    >
      {Object.entries(result.data).map(([key, value]) => (
        <div className="contents" key={key}>
          <dt className="text-muted-foreground font-medium">{key}</dt>
          <dd className="break-words">
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
