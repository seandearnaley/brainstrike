/**
 * A boundary refusal (`failure.kind === 'refusal'`, the wire shape owned by
 * `@brainstrike/assistant-contract`) is a request declined for a reason, such
 * as a host that is closing, not a fault. Matched by shape because that package
 * depends on this one.
 */
function isBoundaryRefusalShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('failure' in value)) {
    return false;
  }
  const { failure } = value;
  return typeof failure === 'object' && failure !== null && 'kind' in failure
    ? failure.kind === 'refusal'
    : false;
}

function refuses(arg: unknown): boolean {
  if (isBoundaryRefusalShape(arg)) {
    return true;
  }
  return typeof arg === 'object' && arg !== null && 'error' in arg
    ? isBoundaryRefusalShape(arg.error)
    : false;
}

/** An error-level log of a refusal logs at warn in every process, as the host does. */
export function refusalAwareLevel<Level extends string>(
  level: Level,
  args: readonly unknown[]
): Level | 'warn' {
  return level === 'error' && args.some(refuses) ? 'warn' : level;
}
