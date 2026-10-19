/**
 * A canonical operation its owner cancelled (BST-2140): the host's own cancel of its scan, or a
 * port operation the port's owner cancelled because it retired the scan's attachment. Both end
 * the scan as its cancellation, never as an independent failure.
 *
 * Classify it with `instanceof`, never by its name: an independent `AbortError` stays a
 * failure. Its name is `AbortError` so that code which handles platform abort reasons by name
 * treats it the same way.
 */
export class CanonicalOperationCancelledError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AbortError';
  }
}
