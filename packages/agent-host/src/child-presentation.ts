/**
 * BST-1932: how a child thread presents itself, derived from the committed
 * tree rather than stored. The call sign and family colour follow the shipped
 * child conversations: a stable name from the child's thread id, and a colour
 * near its parent's that stays apart from every earlier child of the same root.
 */
import { createHash } from 'node:crypto';
import {
  type AgentColor,
  createAgentFamilyColor,
  isAgentColor,
} from '@brainstrike/types/agent-color';

const CALL_SIGNS = [
  'Cedar',
  'Fern',
  'Aspen',
  'Maple',
  'Iris',
  'Willow',
  'Birch',
  'Alder',
  'Hazel',
  'Juniper',
  'Cypress',
  'Rowan',
  'Kestrel',
  'Falcon',
  'Heron',
  'Moth',
  'Lynx',
  'Otter',
  'Orbit',
  'Comet',
  'Nova',
  'Vector',
  'Pixel',
  'Circuit',
  'Flint',
  'Onyx',
  'Quartz',
  'Opal',
  'Ember',
  'Sable',
  'Drift',
  'Echo',
  'Pulse',
  'Tempo',
  'Signal',
  'Riff',
  'Nimbus',
  'Solstice',
  'Vesper',
  'Helix',
  'Prism',
  'Zenith',
  'Beacon',
  'Radar',
  'Volt',
  'Chroma',
  'Moss',
  'Delta',
] as const;

/** A root conversation with no committed colour presents as blue. */
const DEFAULT_ROOT_COLOR: AgentColor = 'blue';

/** Display identity only: never derive ownership or ancestry from it. */
export function hostChildCallSign(threadId: string): string {
  const digest = createHash('sha256').update(threadId).digest();
  const name = CALL_SIGNS[digest.readUInt16BE(0) % CALL_SIGNS.length];
  if (!name) {
    throw new Error('Child conversation call signs are empty.');
  }
  return `${name}-${digest.toString('hex').slice(0, 6)}`;
}

/**
 * The family colour of each child under one root, in creation order: each
 * child's colour stays near its parent's and apart from the root and every
 * child created before it, as each was coloured when it started.
 */
export function hostChildColors(
  rootThreadId: string,
  rootColor: string | undefined,
  children: readonly { readonly parentThreadId: string; readonly threadId: string }[]
): ReadonlyMap<string, AgentColor> {
  const root = rootColor ?? DEFAULT_ROOT_COLOR;
  if (!isAgentColor(root)) {
    throw new Error('The root conversation colour is not an agent colour.');
  }
  const colors = new Map<string, AgentColor>([[rootThreadId, root]]);
  const occupied: AgentColor[] = [root];
  for (const child of children) {
    const parent = colors.get(child.parentThreadId);
    if (!parent) {
      throw new Error('A child conversation was created before its parent.');
    }
    const siblings = children.flatMap((sibling) => {
      const assigned =
        sibling.parentThreadId === child.parentThreadId ? colors.get(sibling.threadId) : undefined;
      return assigned ? [assigned] : [];
    });
    const color = createAgentFamilyColor(parent, child.threadId, siblings, occupied);
    colors.set(child.threadId, color);
    occupied.push(color);
  }
  return colors;
}
