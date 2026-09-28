import type { TabStripItem } from './types';

function areRecordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

/** Fields compared by identity (`===`). */
const IDENTITY_KEYS = [
  'closable',
  'closeTestId',
  'icon',
  'id',
  'label',
  'mark',
  'panelDomId',
  'reorderable',
  'status',
  'statusLabel',
  'tabDomId',
  'testId',
  'tooltip',
] as const satisfies readonly (keyof TabStripItem)[];

/** Fields compared structurally below. */
type StructuralKey = 'appearance' | 'dataAttributes';

/**
 * Compile-time exhaustiveness: a new `TabStripItem` field that is neither an
 * identity key nor a structural key makes this `never` check fail, so memo
 * equality can never silently ignore a rendered field.
 */
type UncomparedKey = Exclude<keyof TabStripItem, (typeof IDENTITY_KEYS)[number] | StructuralKey>;
const EVERY_FIELD_COMPARED: [UncomparedKey] extends [never] ? true : UncomparedKey = true;

/**
 * Value equality over every rendered field, so consumers need not keep the ITEM
 * objects stable. `icon`, `mark` and `appearance.style` are compared by
 * reference: memoize them (per id + state) or every tab re-renders on each
 * parent render.
 */
export function areTabStripItemsEqual(left: TabStripItem, right: TabStripItem): boolean {
  if (left === right) {
    return true;
  }
  return (
    EVERY_FIELD_COMPARED &&
    IDENTITY_KEYS.every((key) => left[key] === right[key]) &&
    left.appearance?.idleClassName === right.appearance?.idleClassName &&
    left.appearance?.selectedClassName === right.appearance?.selectedClassName &&
    left.appearance?.style === right.appearance?.style &&
    areRecordsEqual(left.dataAttributes, right.dataAttributes)
  );
}
