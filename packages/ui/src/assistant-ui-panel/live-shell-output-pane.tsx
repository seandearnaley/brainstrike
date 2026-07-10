/**
 * A live view of a running command's streamed output. The scroll container uses
 * `flex-col-reverse` so it stays pinned to the newest line as slices arrive
 * (like a terminal) — a CSS-only auto-scroll, no imperative scrollTop effect.
 * `role="log"` marks it as a live region for assistive tech.
 */
export function LiveShellOutputPane({ text, truncated }: { text: string; truncated: boolean }) {
  return (
    <div className="px-2.5 pb-1.5">
      <div
        aria-label="Live command output"
        className="flex max-h-40 flex-col-reverse overflow-auto rounded bg-muted/50"
        role="log"
      >
        <pre className="whitespace-pre-wrap break-words p-2 font-mono text-[11px] text-muted-foreground">
          {text}
        </pre>
      </div>
      {truncated ? (
        <p className="pt-0.5 text-[10px] text-muted-foreground italic">
          Live output truncated — the full result is kept when the command finishes.
        </p>
      ) : null}
    </div>
  );
}
