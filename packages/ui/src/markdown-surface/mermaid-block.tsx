// packages/ui/src/markdown-surface/mermaid-block.tsx — Task 5 replaces this stub
export function MermaidBlock({ code }: { readonly code: string }) {
  return (
    <pre data-testid="mermaid-block">
      <code>{code}</code>
    </pre>
  );
}
