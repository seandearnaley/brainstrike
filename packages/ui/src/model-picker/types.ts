/** What the composer's picker shows about an enabled model beside its name. */
export interface ModelPickerModel {
  readonly capabilities: {
    /**
     * Reasoning support, resolved by the assistant-contract
     * `resolveModelReasoningSupport` tri-state. `unknown` renders as an
     * explicit "unverified" affordance; never coerce it.
     */
    readonly reasoning?: 'supported' | 'unsupported' | 'unknown' | undefined;
    /** Image-input support. */
    readonly vision?: 'supported' | 'unsupported' | undefined;
  };
  readonly id: string;
  readonly providerId: string;
}
