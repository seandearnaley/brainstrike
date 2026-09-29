import type { ComponentType, ReactElement } from 'react';

/**
 * Every prop optional, same as `Partial<P>`, but explicitly unioned with
 * `undefined` rather than relying on the built-in optional-property
 * modifier. Under this package's `exactOptionalPropertyTypes`, `Partial<P>`
 * would reject a call site that sets a key to `undefined` explicitly (only
 * omitting the key is allowed) — and these tests do that on purpose (e.g.
 * `argsText: undefined` to spell out "no raw payload"), so `Partial` alone
 * would force rewriting call sites just to satisfy the type checker.
 */
export type LooseProps<P> = { [K in keyof P]?: P[K] | undefined };

/**
 * Builds a `<Component {...props} />` element with `props` checked against
 * the component's own prop type — as a `LooseProps` (every field optional,
 * since a given test scenario usually only sets the ones it cares about) —
 * instead of being erased by an `unknown` cast.
 *
 * Several test files render tool-call message-part components
 * (`ToolFallback`, `SubagentExecutionCard`, `TaskListToolCard`) through a
 * local `Component as unknown as (p: Record<string, unknown>) =>
 * ReactElement` cast. That `unknown` hop hides the component's real
 * signature, so a wrong `status` shape — every one of these components
 * dereferences `status.type` — type-checked cleanly and only broke at
 * runtime. This helper keeps `props` checked against the component's actual
 * signature instead; call it from a file-local `renderX` wrapper that
 * supplies `render()` and any providers the component needs (BST-1685).
 */
export function toolPartElement<P extends object>(
  Component: ComponentType<P>,
  props: LooseProps<P>
): ReactElement {
  return <Component {...(props as P)} />;
}
