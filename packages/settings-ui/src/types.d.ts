declare global {
  interface Window {
    /**
     * Desktop-only secrets bridge, consumed by capability. The shape is
     * defined ONCE in `@brainstrike/assistant-contract/secrets-bridge`; the
     * capability view keeps the typed-credential methods optional for older
     * desktop preloads.
     */
    secrets?: import('@brainstrike/assistant-contract/secrets-bridge').SecretsCapability;
  }
}

export {};
