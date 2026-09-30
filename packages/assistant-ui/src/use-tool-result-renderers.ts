import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { type ComponentProps, type ComponentType, createContext, use } from 'react';
import { isSubagentDelegationToolName } from './subagent-tool-cards';

/**
 * Everything the chain-of-thought tool fallback receives for one tool part,
 * plus the persisted thread that owns the part (`undefined` when the panel is
 * not bound to a persisted thread). A host surface that acts on the part's
 * behalf after the turn ended (MCP Apps) needs this to reach the right run.
 */
export type ToolResultRendererProps = ComponentProps<ToolCallMessagePartComponent> & {
  readonly threadId: string | undefined;
};

/**
 * A host-provided renderer for one shape of raw tool result.
 *
 * Tool names are server-defined, so a renderer claims parts by RESULT SHAPE
 * (`matches`), never by name. This is the seam that keeps host-specific
 * surfaces — MCP Apps, and anything after it — out of the shared foundation
 * UI layer: the foundation knows only this contract, and the adapter package
 * that owns the surface supplies the descriptor.
 */
export interface ToolResultRenderer {
  /* biome-ignore lint/style/useNamingConvention: React component slot */
  readonly Component: ComponentType<ToolResultRendererProps>;
  /** Stable identity for diagnostics and provider de-duplication. */
  readonly kind: string;
  readonly matches: (result: unknown) => boolean;
  /** The mounted surface owns sessions or work that hiding must not tear down. */
  readonly preserveEffectsWhenHidden?: boolean;
}

const EMPTY_RENDERERS: readonly ToolResultRenderer[] = Object.freeze([]);

/**
 * Registered result renderers. Empty in hosts that register none, so the
 * fallback router keeps rendering ordinary tool cards. Kept out of the
 * provider module so that file stays a Fast Refresh boundary.
 */
export const ToolResultRendererContext =
  createContext<readonly ToolResultRenderer[]>(EMPTY_RENDERERS);

/** The renderers this host registered, in provider order (first match wins). */
export function useToolResultRenderers(): readonly ToolResultRenderer[] {
  return use(ToolResultRendererContext);
}

/** Honor the same first matching descriptor as the tool result router. */
export function toolResultPreservesEffectsWhenHidden(
  renderers: readonly ToolResultRenderer[],
  result: unknown
): boolean {
  return (
    result !== undefined &&
    renderers.find((renderer) => renderer.matches(result))?.preserveEffectsWhenHidden === true
  );
}

/** Delegation cards route before registered result surfaces in both presentations. */
export function toolResultPartPreservesEffectsWhenHidden(
  renderers: readonly ToolResultRenderer[],
  part: { readonly type: string; readonly toolName?: string | undefined; readonly result?: unknown }
): boolean {
  return (
    part.type === 'tool-call' &&
    !isSubagentDelegationToolName(part.toolName) &&
    toolResultPreservesEffectsWhenHidden(renderers, part.result)
  );
}
