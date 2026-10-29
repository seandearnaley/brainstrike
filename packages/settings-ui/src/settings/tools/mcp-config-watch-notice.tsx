/**
 * MCP config watcher notice
 *
 * The host watches the MCP config file so outside edits reach the runtime.
 * While that watcher cannot run, edits made elsewhere go unnoticed, so the
 * failure stays on screen until a save or reload restarts the watcher.
 */

export interface McpConfigWatchNoticeProps {
  /** Why the config file watcher cannot run, from the host's config status */
  readonly watchError?: string | undefined;
}

/** Says the config watcher cannot run, and that saving or reloading the config retries it. */
export function McpConfigWatchNotice({ watchError }: McpConfigWatchNoticeProps) {
  if (watchError === undefined) {
    return null;
  }
  return (
    <div
      className="border-destructive/50 bg-destructive/5 text-destructive rounded-md border p-3 text-sm"
      data-testid="mcp-config-watch-error"
      role="alert"
    >
      {`BrainStrike can't watch the MCP config file for outside edits: ${watchError}. Saving or reloading the config retries.`}
    </div>
  );
}
