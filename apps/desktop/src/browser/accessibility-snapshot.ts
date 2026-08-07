/**
 * Format a CDP `Accessibility.getFullAXTree` node list into the compact,
 * ref-annotated text the agent "sees" (BST-1176). This is the a11y-tree-first
 * seeing model: each interactive node gets a stable `[ref=eN]` handle that maps
 * back to its CDP `backendDOMNodeId`, so a later click/type-by-ref can resolve
 * the exact DOM node without coordinates.
 *
 * Pure and driver-agnostic on purpose — the in-process `webContents.debugger`
 * driver feeds it raw CDP nodes; nothing here touches Electron, so it is fully
 * unit-testable and would serve any CDP transport unchanged.
 */

export interface AxValueLike {
  readonly value?: string | number | boolean;
}

/** The subset of a CDP `AXNode` this formatter reads. */
export interface AxSnapshotNode {
  readonly backendDOMNodeId?: number;
  readonly childIds?: readonly string[];
  readonly ignored?: boolean;
  readonly name?: AxValueLike;
  readonly nodeId: string;
  readonly role?: AxValueLike;
}

export interface AccessibilitySnapshot {
  /** `eN` → CDP `backendDOMNodeId`, for click/type-by-ref. Only emitted nodes. */
  readonly refs: Record<string, number>;
  /** Indented `role "name" [ref=eN]` tree. */
  readonly text: string;
  /** True when `maxChars` dropped trailing lines. */
  readonly truncated: boolean;
}

export interface SnapshotOptions {
  /** `interactive` keeps only actionable nodes (+ their structural ancestors). */
  readonly filter: 'interactive' | 'all';
  /** Hard character budget; trailing lines beyond it are dropped. */
  readonly maxChars: number;
}

/**
 * ARIA roles that accept a click/type and therefore earn a `[ref]`. Kept
 * deliberately tight — structural roles (list, article, generic…) are context,
 * not targets.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

interface BuiltLine {
  readonly backendId?: number;
  readonly line: string;
  readonly refKey?: string;
}

function roleOf(node: AxSnapshotNode): string {
  return typeof node.role?.value === 'string' ? node.role.value : '';
}

function isInteractive(node: AxSnapshotNode): boolean {
  const role = roleOf(node);
  return role.length > 0 && INTERACTIVE_ROLES.has(role);
}

export function formatAccessibilitySnapshot(
  nodes: readonly AxSnapshotNode[],
  options: SnapshotOptions
): AccessibilitySnapshot {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childOf = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.childIds ?? []) {
      childOf.add(childId);
    }
  }
  const roots = nodes.filter((node) => !childOf.has(node.nodeId));

  const hasInteractiveDescendant = (node: AxSnapshotNode, seen: Set<string>): boolean => {
    if (seen.has(node.nodeId)) {
      return false;
    }
    seen.add(node.nodeId);
    if (isInteractive(node)) {
      return true;
    }
    return (node.childIds ?? []).some((id) => {
      const child = byId.get(id);
      return Boolean(child && !child.ignored && hasInteractiveDescendant(child, seen));
    });
  };

  const shouldShow = (node: AxSnapshotNode): boolean => {
    if (node.ignored || roleOf(node).length === 0) {
      return false;
    }
    if (options.filter === 'all') {
      return true;
    }
    return isInteractive(node) || hasInteractiveDescendant(node, new Set());
  };

  const built: BuiltLine[] = [];
  let refCounter = 0;
  const visited = new Set<string>();
  const walk = (node: AxSnapshotNode, depth: number): void => {
    if (visited.has(node.nodeId)) {
      return;
    }
    visited.add(node.nodeId);
    const show = shouldShow(node);
    if (show) {
      const name =
        node.name?.value !== undefined && String(node.name.value).length > 0
          ? ` "${node.name.value}"`
          : '';
      const refable = isInteractive(node) && node.backendDOMNodeId !== undefined;
      let refSuffix = '';
      let ref: { refKey: string; backendId: number } | undefined;
      if (refable) {
        refCounter += 1;
        const refKey = `e${refCounter}`;
        refSuffix = ` [ref=${refKey}]`;
        ref = { backendId: node.backendDOMNodeId as number, refKey };
      }
      built.push({
        line: `${'  '.repeat(depth)}${roleOf(node)}${name}${refSuffix}`,
        ...ref,
      });
    }
    const childDepth = show ? depth + 1 : depth;
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) {
        walk(child, childDepth);
      }
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }

  // Accumulate whole lines under the char budget; drops come off the end, so
  // kept refs stay a contiguous e1..eK prefix.
  const lines: string[] = [];
  const refs: Record<string, number> = {};
  let used = 0;
  let truncated = false;
  for (const item of built) {
    const cost = (lines.length === 0 ? 0 : 1) + item.line.length;
    if (used + cost > options.maxChars) {
      truncated = true;
      break;
    }
    used += cost;
    lines.push(item.line);
    if (item.refKey && item.backendId !== undefined) {
      refs[item.refKey] = item.backendId;
    }
  }

  return { refs, text: lines.join('\n'), truncated };
}
