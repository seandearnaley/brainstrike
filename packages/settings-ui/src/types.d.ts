declare global {
  interface Window {
    /**
     * Desktop-only secrets bridge, consumed by capability. The shape is
     * defined ONCE in `@brainstrike/assistant-contract/secrets-bridge`; the
     * capability view keeps the typed-credential methods optional for older
     * desktop preloads.
     */
    /**
     * Desktop-only env bootstrap bridge (BST-1363), consumed by capability.
     * Shape defined ONCE in
     * `@brainstrike/assistant-contract/env-bootstrap-bridge`. Absent on web,
     * where the Environment section renders nothing.
     */
    envBootstrap?: import('@brainstrike/assistant-contract/env-bootstrap-bridge').EnvBootstrapCapability;
    secrets?: import('@brainstrike/assistant-contract/secrets-bridge').SecretsCapability;
  }
}

export {};
