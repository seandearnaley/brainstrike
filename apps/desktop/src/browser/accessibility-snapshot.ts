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

interface AxValueLike {
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

/** Cap a page-supplied accessible name before it enters the model's view. */
const MAX_NAME_LENGTH = 200;

function roleOf(node: AxSnapshotNode): string {
  return typeof node.role?.value === 'string' ? node.role.value : '';
}

function isInteractive(node: AxSnapshotNode): boolean {
  const role = roleOf(node);
  return role.length > 0 && INTERACTIVE_ROLES.has(role);
}

/**
 * An accessible name is UNTRUSTED, page-controlled text (`aria-label`, `alt`,
 * text content) dropped into the agent's primary seeing surface — a trust
 * boundary, since PR3 makes refs actionable. Neutralize the three ways a name
 * could forge formatter structure: collapse all whitespace (a newline would
 * otherwise inject a fake tree line), escape the double-quotes that delimit the
 * name, and defuse literal `[ref=` so a page can't forge a ref handle. Then
 * cap the length.
 */
function sanitizeName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const escaped = collapsed.replace(/"/g, '\\"').replace(/\[ref=/gi, '[ref–');
  return escaped.length > MAX_NAME_LENGTH ? `${escaped.slice(0, MAX_NAME_LENGTH)}…` : escaped;
}

/** Build one indented `role "name" [ref=eN]` line (+ its ref binding). */
function renderLine(node: AxSnapshotNode, depth: number, refKey: string | undefined): BuiltLine {
  const rawName = node.name?.value === undefined ? '' : sanitizeName(String(node.name.value));
  const name = rawName.length > 0 ? ` "${rawName}"` : '';
  const refSuffix = refKey ? ` [ref=${refKey}]` : '';
  const line = `${'  '.repeat(depth)}${roleOf(node)}${name}${refSuffix}`;
  return refKey && node.backendDOMNodeId !== undefined
    ? { backendId: node.backendDOMNodeId, line, refKey }
    : { line };
}

/** Iterative DFS pre-order node list (no recursion; deep-tree safe). */
function preOrderNodes(
  roots: readonly AxSnapshotNode[],
  byId: Map<string, AxSnapshotNode>
): AxSnapshotNode[] {
  const order: AxSnapshotNode[] = [];
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node.nodeId)) {
      continue;
    }
    seen.add(node.nodeId);
    order.push(node);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child && !seen.has(child.nodeId)) {
        stack.push(child);
      }
    }
  }
  return order;
}

function hasKeptChild(
  node: AxSnapshotNode,
  byId: Map<string, AxSnapshotNode>,
  keep: ReadonlySet<string>
): boolean {
  return (node.childIds ?? []).some((id) => {
    const child = byId.get(id);
    return Boolean(child && !child.ignored && keep.has(child.nodeId));
  });
}

/**
 * The set of node ids that are interactive OR have an interactive descendant —
 * i.e. the nodes to keep under `filter: 'interactive'`. Iterative + O(n): a
 * reverse pre-order pass (descendants before ancestors) fills the set without
 * recursion, so a deep attacker-controlled tree can't overflow the stack.
 */
function collectInteractiveNodes(
  roots: readonly AxSnapshotNode[],
  byId: Map<string, AxSnapshotNode>
): Set<string> {
  const preOrder = preOrderNodes(roots, byId);
  const keep = new Set<string>();
  for (let i = preOrder.length - 1; i >= 0; i -= 1) {
    const node = preOrder[i];
    if (node && (isInteractive(node) || hasKeptChild(node, byId, keep))) {
      keep.add(node.nodeId);
    }
  }
  return keep;
}

interface WalkFrame {
  readonly depth: number;
  readonly node: AxSnapshotNode;
}

/** Push a node's children onto the DFS stack in REVERSE so they pop in order. */
function pushChildFrames(
  stack: WalkFrame[],
  node: AxSnapshotNode,
  byId: Map<string, AxSnapshotNode>,
  depth: number
): void {
  const childIds = node.childIds ?? [];
  for (let i = childIds.length - 1; i >= 0; i -= 1) {
    const childId = childIds[i];
    const child = childId === undefined ? undefined : byId.get(childId);
    if (child) {
      stack.push({ depth, node: child });
    }
  }
}

/** Iterative DFS pre-order line build (no recursion; deep-tree safe). */
function buildLines(
  roots: readonly AxSnapshotNode[],
  byId: Map<string, AxSnapshotNode>,
  shouldShow: (node: AxSnapshotNode) => boolean
): BuiltLine[] {
  const built: BuiltLine[] = [];
  const visited = new Set<string>();
  let refCounter = 0;
  const stack: WalkFrame[] = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const node = roots[i];
    if (node) {
      stack.push({ depth: 0, node });
    }
  }
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame || visited.has(frame.node.nodeId)) {
      continue;
    }
    const { node, depth } = frame;
    visited.add(node.nodeId);
    const show = shouldShow(node);
    if (show) {
      const refKey =
        isInteractive(node) && node.backendDOMNodeId !== undefined ? `e${++refCounter}` : undefined;
      built.push(renderLine(node, depth, refKey));
    }
    pushChildFrames(stack, node, byId, show ? depth + 1 : depth);
  }
  return built;
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

  // `interactive` keeps only nodes that are interactive or contain one; both
  // this and the line build below are iterative so a deep tree can't overflow
  // the main-process stack.
  const keep = options.filter === 'interactive' ? collectInteractiveNodes(roots, byId) : null;
  const shouldShow = (node: AxSnapshotNode): boolean => {
    if (node.ignored || roleOf(node).length === 0) {
      return false;
    }
    return keep === null || keep.has(node.nodeId);
  };

  const built = buildLines(roots, byId, shouldShow);

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
