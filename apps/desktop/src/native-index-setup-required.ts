/** A valid but incomplete user choice, not a failed index operation. */
export class NativeIndexSetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeIndexSetupRequiredError';
  }
}
