/** "Anthropic", or "Anthropic via OpenRouter" when a gateway serves another maker's model. */
export function modelMarkLabel(input: {
  readonly providerId: string;
  readonly providerName: string;
  readonly vendorId?: string | undefined;
  readonly vendorName?: string | undefined;
}): string {
  if (!(input.vendorId && input.vendorName) || input.vendorId === input.providerId) {
    return input.vendorName ?? input.providerName;
  }
  return `${input.vendorName} via ${input.providerName}`;
}
