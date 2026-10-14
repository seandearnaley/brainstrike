/** Clear content preserves model choices, presets, settings and credentials. */
export interface ContentClearResult {
  readonly deletedChunks: number | null;
  readonly deletedFiles: number;
}
export interface ContentClearCapability {
  clear(confirmation: 'CONFIRM_CLEAR_DATABASE'): Promise<ContentClearResult>;
}
