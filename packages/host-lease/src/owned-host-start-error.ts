/** A failed owned start, emitted only by its physical exit or existing startup deadline. */
export class OwnedHostStartError extends Error {
  readonly exitCode: number | undefined;
  readonly reason: 'deadline' | 'exit';

  constructor(
    facts: { readonly reason: 'deadline' } | { readonly reason: 'exit'; readonly exitCode: number },
    cause: Error
  ) {
    super(cause.message, { cause });
    this.name = 'OwnedHostStartError';
    this.reason = facts.reason;
    this.exitCode = facts.reason === 'exit' ? facts.exitCode : undefined;
  }
}
