/**
 * Error Utilities
 *
 * Shared error handling functions for consistent error detection
 * across the codebase.
 *
 * @module error-utils
 */

/**
 * Check if an error is an abort/cancellation error.
 *
 * Handles multiple abort scenarios:
 * - DOMException with name 'AbortError' (from AbortController)
 * - Error with name 'AbortError' (from various sources)
 * - Error messages containing 'abort' (from various sources)
 * - Error messages containing 'cancelled' or 'canceled' (spelling variants)
 *
 * @param error - The error to check
 * @returns true if the error indicates an abort/cancellation
 *
 * @example
 * ```ts
 * try {
 *   await fetchWithSignal(signal);
 * } catch (error) {
 *   if (isAbortError(error)) {
 *     // User cancelled, no need to show error
 *     return;
 *   }
 *   // Handle real error
 *   showError(error);
 * }
 * ```
 */
export function isAbortError(error: unknown): boolean {
  // Standard DOMException from AbortController.abort()
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }

  // Error with name or message indicating abort
  if (error instanceof Error) {
    // Check error.name for AbortError (common pattern)
    if (error.name === 'AbortError') {
      return true;
    }
    // Check message for abort/cancelled patterns
    const message = error.message.toLowerCase();
    return (
      message.includes('abort') || message.includes('cancelled') || message.includes('canceled')
    );
  }

  return false;
}

/**
 * Get a human-readable error message from an unknown error.
 *
 * Handles various error types gracefully:
 * - Error instances: uses the message property
 * - Strings: uses the string directly
 * - Objects: uses JSON.stringify
 * - Other: uses String() conversion
 *
 * @param error - The error to extract a message from
 * @param fallback - Fallback message if extraction fails
 * @returns Human-readable error message
 *
 * @example
 * ```ts
 * catch (error) {
 *   logger.error(getErrorMessage(error));
 * }
 * ```
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }
  return String(error) || fallback;
}
