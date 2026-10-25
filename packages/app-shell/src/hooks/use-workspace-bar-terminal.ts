/**
 * The workspace bar's Open-in-Terminal wiring (BST-1457), pulled out of
 * `use-workspace-bar.ts` to keep that hook's cognitive complexity under
 * Biome's ceiling — the same pressure `use-workspace-bar-write-derive.ts`
 * was split out under. Unlike that file this seam is not pure derive logic:
 * it owns the capability gate and the stable callback, so it stays a real
 * hook rather than a plain function.
 *
 * Returns a ready-to-spread partial (the `checkoutEntry`/`forgeEntry`/
 * `modeEntry` idiom already established in `use-workspace-bar.ts`) so the
 * call site carries no conditional of its own — the capability gate is
 * pulled out entirely rather than merely relocated, keeping the calling
 * hook's cognitive-complexity budget untouched by this wiring.
 */
import { useCallback } from 'react';
import { useTerminalTargetStore } from '../stores/terminal-target-store';
import { useTerminalBridge } from '../workspace-terminal-services';

/**
 * The provided terminal bridge IS the gate, so a tree without one (web) omits
 * the affordance rather than rendering a dead row. A
 * mounted root is its own cwd, so `rootId` and `path` name the same folder
 * here; both still travel because main authorizes on the first and spawns
 * in the second.
 */
export function useWorkspaceBarTerminal(): {
  readonly onOpenTerminal?: (rootId: string, path: string) => void;
} {
  const terminalAvailable = useTerminalBridge() !== null;
  const onOpenTerminal = useCallback((rootId: string, path: string) => {
    useTerminalTargetStore.getState().openTerminalAt({ cwd: path, rootId });
  }, []);
  return terminalAvailable ? { onOpenTerminal } : {};
}
