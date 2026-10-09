/**
 * The agent host's content outcomes (BST-1930 c5d): a verb's result, or a
 * refusal in the content taxonomy that crosses without any server text.
 */
type ContentOutcome<T> =
  | { readonly ok: true; readonly result: T }
  | {
      readonly error: {
        readonly category: string;
        readonly code: string;
        readonly message: string;
      };
      readonly ok: false;
    };

/** A refusal becomes a clean Error carrying only the content taxonomy, never server text. */
export function unwrapContent<T>(outcome: ContentOutcome<T>): T {
  if (outcome.ok) {
    return outcome.result;
  }
  const { category, code, message } = outcome.error;
  throw Object.assign(new Error(`${message} (${category} · ${code})`), { category, code });
}
