/**
 * Stable delegation identity colour (swarm-aware approval UI, 2026-09-15).
 *
 * Each delegation (persona + invocation) is identified by the delegation
 * call id (`parentToolCallId` on a `delegation.path` edge). Hashing it picks
 * one of eight curated hues (`--bs-delegation-1..8` in
 * `packages/ui/src/globals.css`, light on `:root`, dark under `.dark`). The
 * hash is FNV-1a so the same thread paints the same rails after a reload or
 * an upgrade; there is no per-session assignment table to lose.
 *
 * Colour is never the only signal: every rail is paired with the persona
 * label (ui-conventions "Step rows": colour alone never carries the state).
 */
export const DELEGATION_COLOUR_COUNT = 8;
export type DelegationColourIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/** FNV-1a over UTF-16 code units, 32-bit. */
function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

export function delegationColourIndex(delegationId: string): DelegationColourIndex {
  if (delegationId.length === 0) {
    throw new Error('delegationColourIndex requires a non-empty delegation id');
  }
  const bucket = (fnv1a32(delegationId) % DELEGATION_COLOUR_COUNT) + 1;
  // `bucket` is 1..8 by construction; the cast names that range for callers.
  return bucket as DelegationColourIndex;
}

/** One rail per ancestor edge, outermost delegation first. */
export function delegationRailIndices(
  path: readonly { readonly parentToolCallId: string }[]
): readonly DelegationColourIndex[] {
  return path.map((edge) => delegationColourIndex(edge.parentToolCallId));
}
