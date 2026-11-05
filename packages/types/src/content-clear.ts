/** Clear content preserves model choices, presets, settings and credentials. */
export interface ContentClearCapability {
  clear(confirmation: 'CONFIRM_CLEAR_DATABASE'): Promise<void>;
}
