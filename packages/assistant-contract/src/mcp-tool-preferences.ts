/**
 * The one shape for "the saved MCP tool preferences could not be read"
 * (BST-1615).
 *
 * It crosses a process boundary — desktop main records it, the IPC tool-stats
 * payload carries it, and the settings panel renders it — so it lives here
 * rather than being redeclared structurally at each end. Three compatible-by-
 * accident copies would let a renamed field or a new `kind` compile clean and
 * silently drop on the way through.
 */

/** Why the preferences file could not be turned into preferences. */
export type McpToolPreferencesFaultKind =
  /** The file was read but is corrupt or does not match the schema. */
  | 'invalid'
  /** The file exists but the read itself failed (permissions, IO). */
  | 'unreadable';

export interface McpToolPreferencesFault {
  kind: McpToolPreferencesFaultKind;
  /** User-facing sentence naming the file and what to do about it. */
  message: string;
  /** Absolute path of the preferences file that could not be read. */
  path: string;
}
